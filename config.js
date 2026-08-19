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
  //
  // Public by design — an OAuth client ID ships in the page source of every
  // Google-integrated website. It is not a secret and the matching client
  // secret is unused (a browser app cannot keep one). What actually gates
  // access is the test-user list on the Google Auth Platform "Audience"
  // page plus the authorised JavaScript origins on the client.
  clientId: "858822303789-k54blu25m75l2kmu82ikaiuem62ka6mg.apps.googleusercontent.com",

  // Which site/company inventory these captures belong to. Must match the
  // tenant SlabWizard is importing on the PC. Letters, digits, dash,
  // underscore and dot only.
  tenant: "default",

  // Name of the folder this app creates in the user's Google Drive. The PC
  // reads the same folder through Google Drive for Desktop.
  folderName: "SlabWizard Captures",
};
