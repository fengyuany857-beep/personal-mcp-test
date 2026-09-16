import { defaultLocalQrPath, Rail12306LocalAuthenticatedProvider } from "../runner/12306-local-auth-readonly.ts";

const aliasKey = process.env.RAIL12306_ALIAS_KEY?.trim();
if (!aliasKey || aliasKey.length < 16) {
  console.error(JSON.stringify({ ok: false, error_code: "RAIL12306_ALIAS_KEY_REQUIRED", hint: "Set a local-only RAIL12306_ALIAS_KEY with at least 16 characters. Never commit or paste it into chat." }));
  process.exit(2);
}

const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey });

try {
  let state = await provider.sessionState();
  if (state !== "READY") {
    const challenge = await provider.beginQrLogin(defaultLocalQrPath());
    console.log(JSON.stringify({
      ok: true,
      stage: "QR_REQUIRED",
      qr_file: challenge.qr_file,
      expires_at: challenge.expires_at,
      action: "Scan this local PNG with the official Railway 12306 app and confirm login.",
      raw_cookie_logged: false,
      order_effect: "NONE",
    }, null, 2));
    state = await provider.waitForQrConfirmation(challenge.uuid);
  }

  const passengers = await provider.readPassengers();
  const pendingOrders = await provider.readPendingOrders();
  console.log(JSON.stringify({
    ok: true,
    mode: "AUTHENTICATED_READ_ONLY",
    session_state: state,
    passenger_refs: passengers,
    pending_orders: pendingOrders,
    raw_cookie_logged: false,
    raw_pii_logged: false,
    order_effect: "NONE",
    submit_capability: "NOT_AVAILABLE",
    payment_capability: "NOT_AVAILABLE",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode: "AUTHENTICATED_READ_ONLY",
    error_code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    raw_cookie_logged: false,
    raw_pii_logged: false,
    order_effect: "NONE",
    submit_capability: "NOT_AVAILABLE",
    payment_capability: "NOT_AVAILABLE",
  }));
  process.exitCode = 1;
}
