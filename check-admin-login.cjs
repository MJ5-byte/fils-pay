// Tries step 1 of the FilsPay admin login with the password saved in
// filspay-admin-login.txt, and prints only the API's answer.
// Run from this folder:  node check-admin-login.cjs
// (.cjs because the repo's package.json sets "type": "module".)
const fs = require("fs");
const path = require("path");

const text = fs.readFileSync(path.join(__dirname, "filspay-admin-login.txt"), "utf8");
const password = text.match(/^Password: (.*)$/m)[1].trim();
const email = "superadmin@filspay.test";

fetch("https://fp-api-tzakir.dilmune.app/v1/admin/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://fp-admin-tzakir.dilmune.app" },
  body: JSON.stringify({ email, password }),
})
  .then(async (res) => {
    const body = await res.text();
    console.log("HTTP", res.status);
    console.log(res.ok ? "Password accepted. Step 1 works; the problem is in the browser form." : body);
  })
  .catch((err) => console.error("Request failed:", err.message));
