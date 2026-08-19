/* Deployment defaults for SlabWizard Capture.
 *
 * Everything here can also be set in the app's own Settings screen, which
 * wins over these values — this file exists so you can ship a build that is
 * already configured for a yard and hand phones out without setup.
 *
 * See README.md for how to obtain the OAuth client ID.
 */
window.SLABWIZARD_CONFIG = {
  // "xxxxxxxx.apps.googleusercontent.com" from Google Cloud Console.
  clientId: "",

  // Which site/company inventory these captures belong to. Must match the
  // tenant SlabWizard is importing on the PC. Letters, digits, dash,
  // underscore and dot only.
  tenant: "default",

  // Name of the folder this app creates in the user's Google Drive. The PC
  // reads the same folder through Google Drive for Desktop.
  folderName: "SlabWizard Captures",
};
