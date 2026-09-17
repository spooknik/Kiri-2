/**
 * Version of this SDK, reported in the `hello` event and used for the
 * `kiri-plugin.json` `sdk` range check.
 *
 * Kept as a literal (not read from package.json) so it survives bundling and
 * `--permission` sandboxes that cannot read outside the plugin directory.
 * `version.test.ts` asserts it matches package.json.
 */
export const SDK_VERSION = "2.0.0-alpha.0";
