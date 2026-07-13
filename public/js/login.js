// Login page controller. Posts credentials to the API and, on success, sends
// the reviewer to the dashboard. If already signed in, skip straight through.
const $ = (id) => document.getElementById(id);

async function alreadyAuthed() {
  try {
    const res = await fetch("api/auth/me");
    return res.ok;
  } catch {
    return false;
  }
}

if (await alreadyAuthed()) {
  location.replace("index.html");
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("submitBtn");
  const err = $("error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch("api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value, password: $("password").value }),
    });
    if (res.ok) {
      location.replace("index.html");
      return;
    }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || "Sign in failed.";
    err.hidden = false;
  } catch {
    err.textContent = "Could not reach the server.";
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
