import { Rail12306LocalAuthenticatedProvider } from "./12306-local-auth-readonly.ts";
import {
  Cloud12306SessionTransport,
  Rail12306CloudSessionController,
  SqliteEncrypted12306SessionStore,
  type PersistableLocalSessionTransport,
} from "./12306-session-persistence.ts";

export type Rail12306CloudSessionRuntime = {
  transport: PersistableLocalSessionTransport;
  provider: Rail12306LocalAuthenticatedProvider;
  controller: Rail12306CloudSessionController;
  store: SqliteEncrypted12306SessionStore;
  close(): void;
};

/**
 * Canonical wiring for the cloud authenticated-read-only session domain.
 * The provider and controller are deliberately bound to exactly the same
 * transport instance, preventing a split cookie jar during QR confirmation.
 * Raw encryption material remains a host-supplied Buffer and is never returned.
 */
export function createRail12306CloudSessionRuntime(options: {
  accountRef: string;
  aliasKey: string;
  databasePath: string;
  encryptionKey: Buffer;
  transport?: PersistableLocalSessionTransport;
}): Rail12306CloudSessionRuntime {
  if (!options.accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
  const transport = options.transport ?? new Cloud12306SessionTransport();
  const store = new SqliteEncrypted12306SessionStore(options.databasePath, options.encryptionKey);
  const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: options.aliasKey, transport });
  const controller = new Rail12306CloudSessionController({
    accountRef: options.accountRef,
    transport,
    provider,
    store,
  });
  return {
    transport,
    provider,
    controller,
    store,
    close() { store.close(); },
  };
}
