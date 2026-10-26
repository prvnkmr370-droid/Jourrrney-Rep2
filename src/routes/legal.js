/**
 * Public web pages Google Play and Meta require: a Privacy Policy, Terms of
 * Service, and a page where anyone can delete their account without the app.
 *
 *   GET /privacy         the Privacy Policy
 *   GET /terms           the Terms of Service
 *   GET /delete-account  email + emailed code -> account and data deleted
 *
 * The wording lives in src/legal/content.js (shared with the in-app screens).
 * The delete page uses POST /auth/request-code and POST /auth/delete-with-code.
 * Mounted at "/" in index.js.
 */
const express = require("express");
const { UPDATED, PRIVACY, TERMS } = require("../legal/content");

const router = express.Router();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function supportEmail() {
  const v = (process.env.SUPPORT_EMAIL || "").trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : "";
}

function contactHtml() {
  const mail = supportEmail();
  return mail
    ? `Questions about your information? Email us at <a href="mailto:${esc(mail)}">${esc(mail)}</a>.`
    : "Questions about your information? Use the contact email shown on Jourrrney's Google Play page.";
}

const STYLE = `
:root{--bg:#fbf9f6;--card:#ffffff;--ink:#1c1917;--muted:#57534e;--line:#e7e2db;--brand:#333c81;--danger:#b91c1c;--danger-bg:#fef2f2}
@media (prefers-color-scheme:dark){:root{--bg:#14110f;--card:#1f1b18;--ink:#f5f1ec;--muted:#b8b0a6;--line:#38322d;--brand:#a9b1f5;--danger:#fca5a5;--danger-bg:#3b1414}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:680px;margin:0 auto;padding:24px 20px 64px}
.brand{font-size:13px;letter-spacing:2px;font-weight:700;color:var(--brand);margin:0 0 4px}
h1{font-size:30px;line-height:1.25;margin:0 0 6px}
h2{font-size:21px;line-height:1.3;margin:32px 0 8px}
p,li{margin:0 0 12px}
ul{padding-left:22px;margin:0 0 12px}
.updated{color:var(--muted);font-size:15px;margin:0 0 8px}
a{color:var(--brand)}
nav{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:15px}
nav a{margin-right:16px}
`;

function page(title, inner, { head = "", script = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Jourrrney</title><meta name="robots" content="index,follow"><style>${STYLE}${head}</style></head><body><main><p class="brand">JOURRRNEY</p>${inner}<nav><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/delete-account">Delete account</a></nav></main>${script}</body></html>`;
}

function renderBody(items) {
  return items
    .map((item) => {
      if (typeof item === "string") return `<p>${esc(item)}</p>`;
      if (item.list) return `<ul>${item.list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>`;
      if (item.contact) return `<p>${contactHtml()}</p>`;
      return "";
    })
    .join("");
}

function renderDoc(doc) {
  const sections = doc.sections.map((s) => `<h2>${esc(s.heading)}</h2>${renderBody(s.body)}`).join("");
  return page(doc.title, `<h1>${esc(doc.title)}</h1><p class="updated">Last updated ${esc(UPDATED)}</p>${sections}`);
}

router.get("/privacy", (_req, res) => res.type("html").send(renderDoc(PRIVACY)));
router.get("/terms", (_req, res) => res.type("html").send(renderDoc(TERMS)));

const DELETE_HEAD = `
label{display:block;font-weight:600;margin:20px 0 6px}
input{width:100%;min-height:48px;font:inherit;padding:10px 14px;border:1.5px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}
input:focus{outline:3px solid var(--brand);outline-offset:1px}
button{min-height:48px;padding:10px 22px;border-radius:12px;border:0;font:inherit;font-weight:700;cursor:pointer;margin:16px 12px 0 0}
button.primary{background:var(--brand);color:#fff}
button.danger{background:#b91c1c;color:#fff}
button.plain{background:transparent;color:var(--ink);border:1.5px solid var(--line)}
button:disabled{opacity:.55;cursor:default}
.warn{background:var(--danger-bg);border-radius:14px;padding:14px 16px;margin:16px 0}
.warn p,.warn ul{margin-bottom:6px}
.msg{margin-top:16px;font-weight:600}
.msg.err{color:var(--danger)}
.done{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
[hidden]{display:none!important}
`;

const DELETE_SCRIPT = `<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var email="";
  function show(step){$("step1").hidden=step!==1;$("step2").hidden=step!==2;$("step3").hidden=step!==3}
  function say(id,text,isErr){var el=$(id);el.textContent=text||"";el.className="msg"+(isErr?" err":"")}
  function post(path,body){
    return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,data:d}})});
  }
  var fail="Something went wrong. Please check your connection and try again.";
  $("send").addEventListener("click",function(){
    email=$("email").value.trim();
    if(!email){say("msg1","Please enter your email address.",true);return}
    $("send").disabled=true;say("msg1","Sending the code...");
    post("/auth/request-code",{email:email}).then(function(r){
      $("send").disabled=false;
      if(!r.ok){say("msg1",r.data.error||fail,true);return}
      $("sentto").textContent=email;say("msg1","");say("msg2","");show(2);$("code").focus();
    }).catch(function(){$("send").disabled=false;say("msg1",fail,true)});
  });
  $("back").addEventListener("click",function(){say("msg2","");show(1)});
  $("confirm").addEventListener("click",function(){
    var code=$("code").value.trim();
    if(!code){say("msg2","Please enter the 6-digit code from the email.",true);return}
    $("confirm").disabled=true;say("msg2","Deleting...");
    post("/auth/delete-with-code",{email:email,code:code}).then(function(r){
      $("confirm").disabled=false;
      if(!r.ok){say("msg2",r.data.error||fail,true);return}
      show(3);
    }).catch(function(){$("confirm").disabled=false;say("msg2",fail,true)});
  });
})();
</script>`;

router.get("/delete-account", (_req, res) => {
  const inner = `
<h1>Delete your Jourrrney account</h1>
<p class="updated">Use this page if you can't open the app, or just prefer the web. In the app, you can also go to Profile, then Settings, then Delete my account.</p>
<div class="warn">
  <p><strong>This permanently deletes:</strong></p>
  <ul><li>your email address and name,</li><li>the profile details you added,</li><li>your trip-planning history with Tia.</li></ul>
  <p>It cannot be undone. Things saved only on your phone, such as hearted places and saved trips, are not on our server and stay on your phone until you remove the app.</p>
</div>

<section id="step1">
  <label for="email">Your email address</label>
  <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com">
  <button class="primary" id="send" type="button">Send me a code</button>
  <p class="msg" id="msg1" role="status" aria-live="polite"></p>
</section>

<section id="step2" hidden>
  <p>We sent a 6-digit code to <strong id="sentto"></strong>. It works for 10 minutes. Check your spam folder if it does not arrive.</p>
  <label for="code">6-digit code</label>
  <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
  <button class="danger" id="confirm" type="button">Delete my account permanently</button>
  <button class="plain" id="back" type="button">Go back</button>
  <p class="msg" id="msg2" role="status" aria-live="polite"></p>
</section>

<section id="step3" hidden>
  <div class="done"><p><strong>Your account has been deleted.</strong></p><p>Your email address, name, profile details and trip-planning history were removed from our database. Thank you for trying Jourrrney.</p></div>
</section>

<p style="margin-top:28px">${contactHtml()}</p>`;
  res.type("html").send(page("Delete your account", inner, { head: DELETE_HEAD, script: DELETE_SCRIPT }));
});

module.exports = router;
