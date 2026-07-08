const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");

// Rename the JSON you downloaded from Google Cloud Console to exactly this
// and put it in this project folder.
const CREDENTIALS_PATH = path.join(__dirname, "client_secret.json");
// This is what gets produced by running this script — a long-lived refresh
// token. Keep it as secret as an API key (add it to .gitignore).
const TOKEN_PATH = path.join(__dirname, "youtube-token.json");

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing ${CREDENTIALS_PATH} — rename the JSON you downloaded from Google Cloud Console to "client_secret.json" and put it in this folder.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  // Desktop-app credentials are nested under "installed" in the downloaded JSON.
  return raw.installed || raw.web;
}

async function main() {
  const { client_id, client_secret } = loadCredentials();

  // "Desktop app" OAuth clients use a loopback redirect — Google allows any
  // localhost port without pre-registering it, so we just spin up a throwaway
  // local server to catch the one redirect after you click "Allow."
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required — this is what makes Google issue a refresh_token
    prompt: "consent", // forces a fresh refresh_token even if you've authorized this app before
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  console.log("\nOpen this URL in your browser and log in with the Google account you added as a test user:\n");
  console.log(authUrl);
  console.log("\nWaiting for you to approve access...\n");

  const code = await new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end("Authorization failed — you can close this tab and check the terminal.");
        reject(new Error(`Google returned an error: ${error}`));
        return;
      }
      if (code) {
        res.end("Authorization successful — you can close this tab and go back to the terminal.");
        resolve(code);
      }
    });
  });

  server.close();

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh_token. This usually happens if you've authorized this app before " +
        "without revoking it first. Go to https://myaccount.google.com/permissions, remove access for this app, " +
        "and run this script again."
    );
  }

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Saved: ${TOKEN_PATH}`);
  console.log(
    "This file is what lets uploadVideo.js run with no browser step from now on — including once this moves to Render. Keep it out of git."
  );
}

main().catch((err) => {
  console.error("Authorization failed:", err.message);
  process.exit(1);
});