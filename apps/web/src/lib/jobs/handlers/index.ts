/**
 * Job handler registry.
 *
 * Importing this module is what puts handlers in the registry: each file calls
 * `registerJobHandler` at module scope, so `instrumentation.ts` awaits this
 * import once before starting the runner. Nothing else imports the handler
 * files directly — a kind with no registered handler fails its jobs with
 * `NO_HANDLER` rather than leaving them QUEUED forever.
 */
import "./manual-upload";
import "./pdf-import";
import "./optimize";
import "./v1-import";
import "./plugin-install";
import "./source-sync";

export {};
