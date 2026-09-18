export const IPHONE_AUTH_APP_JS = String.raw`(() => {
  "use strict";

  const STORAGE_KEY = "rail12306AuthCode";
  let accessCode = "";
  let challengeId = "";
  let qrBase64 = "";
  let stopped = false;

  const q = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error("UI_ELEMENT_MISSING_" + id);
    return element;
  };

  const show = (id, on) => q(id).classList.toggle("hidden", !on);

  function errorText(error) {
    return error && typeof error.message === "string" ? error.message : "UNKNOWN_ERROR";
  }

  function setStatus(text, kind = "") {
    const status = q("status");
    status.textContent = text;
    status.className = "status " + kind;
  }

  function storageGet() {
    try {
      return window.sessionStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storageSet(value) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Safari/private-context storage can be unavailable; URL fragment remains sufficient.
    }
  }

  function storageRemove() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Fail open for UI continuity; access authorization still occurs server-side.
    }
  }

  function fragmentCode() {
    try {
      const hash = typeof window.location.hash === "string" ? window.location.hash : "";
      const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
      return params.get("code") || "";
    } catch {
      return "";
    }
  }

  function clearFragment() {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      // Cosmetic cleanup only. A blocked history API must not stop auth bootstrap.
    }
  }

  async function post(path, payload) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 35000) : null;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, access_code: accessCode }),
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
      const data = await response.json().catch(() => ({ error: "INVALID_RESPONSE" }));
      if (!response.ok) {
        const error = new Error(data.error || ("HTTP_" + response.status));
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("PORTAL_REQUEST_TIMEOUT");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function renderReady(data) {
    stopped = true;
    show("qrArea", false);
    setStatus(
      "READY：登录成功，会话已加密保存。\n乘车人数量：" + data.passenger_count +
      "\n待支付订单数量：" + data.pending_order_count +
      "\n下单能力：关闭\n支付能力：关闭",
      "ok",
    );
  }

  function bytesFromBase64(value) {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  function downloadQrFallback() {
    const anchor = document.createElement("a");
    anchor.href = "data:image/png;base64," + qrBase64;
    anchor.download = "12306-login-qr.png";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setStatus("如果 Safari 没直接保存，请长按二维码并选择保存到照片。", "warn");
  }

  async function shareQr() {
    if (!qrBase64) return;
    try {
      const file = new File([bytesFromBase64(qrBase64)], "12306-login-qr.png", { type: "image/png" });
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ files: [file], title: "12306 登录二维码" });
        return;
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
    downloadQrFallback();
  }

  async function poll() {
    if (stopped || !challengeId) return;
    try {
      const data = await post("/auth/api/qr/poll", { challenge_id: challengeId });
      if (data.state === "READY") {
        renderReady(data);
        return;
      }
      setStatus("等待你在 12306 App 从相册读取二维码并确认…");
      setTimeout(() => void poll(), 700);
    } catch (error) {
      const message = errorText(error);
      if (message === "RAIL12306_QR_EXPIRED") {
        stopped = true;
        setStatus("二维码已过期。点“重新生成”即可。", "warn");
        return;
      }
      if (message === "RAIL12306_QR_CHALLENGE_NOT_FOUND") {
        stopped = true;
        setStatus("扫码会话已失效。请重新生成二维码。", "warn");
        return;
      }
      setStatus("检查登录状态失败：" + message, "warn");
      setTimeout(() => void poll(), 1500);
    }
  }

  async function startQr() {
    if (!accessCode) {
      show("accessBox", true);
      setStatus("请输入此页面的访问码。", "warn");
      return;
    }

    stopped = true;
    challengeId = "";
    qrBase64 = "";
    show("accessBox", false);
    show("qrArea", false);
    setStatus("正在向 12306 获取官方登录二维码…");

    try {
      const data = await post("/auth/api/qr/start", {});
      if (data.state === "READY") {
        renderReady(data);
        return;
      }
      challengeId = data.challenge_id;
      qrBase64 = data.qr_image_base64;
      q("qr").src = "data:image/png;base64," + qrBase64;
      show("qrArea", true);
      stopped = false;
      setStatus("二维码已生成。保存到照片后，在 12306 App 扫码页选择相册读取。");
      void poll();
    } catch (error) {
      if (error && error.status === 401) {
        accessCode = "";
        storageRemove();
        show("accessBox", true);
        setStatus("访问码无效。", "warn");
        return;
      }
      setStatus("生成二维码失败：" + errorText(error), "warn");
    }
  }

  function bindActions() {
    q("unlock").onclick = () => {
      try {
        accessCode = String(q("access").value || "").trim();
        if (!accessCode) return;
        storageSet(accessCode);
        void startQr();
      } catch (error) {
        setStatus("页面操作失败：" + errorText(error), "warn");
      }
    };
    q("share").onclick = () => void shareQr();
    q("regen").onclick = () => void startQr();
  }

  async function bootstrap() {
    try {
      setStatus("页面脚本已启动，正在准备扫码登录…");
      accessCode = storageGet();
      const code = fragmentCode();
      if (code) {
        accessCode = code;
        storageSet(code);
        clearFragment();
      }
      bindActions();
      await startQr();
    } catch (error) {
      try {
        show("accessBox", true);
        setStatus("页面启动失败：" + errorText(error), "warn");
      } catch {
        // If even the status node is missing, there is nothing safe left to render.
      }
    }
  }

  window.__RAIL12306_AUTH_APP_BOOT = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
})();
`;
