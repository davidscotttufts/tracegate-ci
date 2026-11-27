#!/usr/bin/env bash
# A role preflight: are this machine's deploy sign-ins still valid?
#
#   "roles": { "deployer": { "preflight": "bash examples/preflight-signins.sh" } }
#
# `tracegate role claim|take` runs it on the machine that wants the role and refuses
# the role if it exits non-zero, so a machine whose sign-in has expired never becomes
# the deployer. For each failure it prints which sign-in failed and the exact command
# that renews it without a browser on this machine (run it over SSH, e.g. Tailscale).
#
# It never prints a token or a key: every check's output goes to /dev/null, and the
# only thing it reads back is an account name.
#
# Settings (environment):
#   SIGNINS="gcloud firebase gh"   which to check (default: all three)
#   SIGNINS_ADC=1                  also check application-default credentials
#   GOOGLE_APPLICATION_CREDENTIALS a service account key file: if it exists and is
#                                  readable, the Google and Firebase checks pass from it
set -u
SIGNINS="${SIGNINS:-gcloud firebase gh}"
failed=0
ok()   { printf 'preflight: ok      %s\n' "$1"; }
bad()  { printf 'preflight: FAILED  %s\n          renew:  %s\n' "$1" "$2"; failed=$((failed + 1)); }
has()  { command -v "$1" >/dev/null 2>&1; }
want() { case " $SIGNINS " in *" $1 "*) return 0;; *) return 1;; esac; }

# A readable service account key: the account is its client_email, and nothing else is read.
sa=""
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  if [ -r "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    sa=$(node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j.client_email || "a service account")); } catch { process.stdout.write("a service account (unreadable JSON)"); }' "$GOOGLE_APPLICATION_CREDENTIALS" 2>/dev/null)
    [ -n "$sa" ] || sa="a service account"
  else
    bad "GOOGLE_APPLICATION_CREDENTIALS ($GOOGLE_APPLICATION_CREDENTIALS) is set but not a readable file" "chmod 600 the key and check the path, or unset it"
  fi
fi

if want gcloud; then
  if [ -n "$sa" ]; then ok "Google Cloud: from the service account $sa (GOOGLE_APPLICATION_CREDENTIALS)"
  elif ! has gcloud; then bad "Google Cloud: gcloud is not installed" "install the Google Cloud CLI"
  else
    acct=$(gcloud config get-value account 2>/dev/null | tr -d '\r' | head -1)
    if gcloud auth print-access-token >/dev/null 2>&1; then ok "Google Cloud: ${acct:-signed in}"
    else bad "Google Cloud: ${acct:-no account} (gcloud auth print-access-token failed)" "gcloud auth login ${acct:-<account>} --no-browser   # then run the printed 'gcloud auth login --remote-bootstrap=…' on a machine with a browser and paste its output back"; fi
    if [ "${SIGNINS_ADC:-0}" = 1 ]; then
      if gcloud auth application-default print-access-token >/dev/null 2>&1; then ok "Google Cloud application-default credentials"
      else bad "Google Cloud application-default credentials" "gcloud auth application-default login --no-browser   # same remote-bootstrap steps"; fi
    fi
  fi
fi

if want firebase; then
  if [ -n "$sa" ]; then ok "Firebase: from the service account $sa (GOOGLE_APPLICATION_CREDENTIALS)"
  elif ! has firebase; then bad "Firebase: the firebase CLI is not installed" "npm i -g firebase-tools"
  elif firebase projects:list >/dev/null 2>&1; then ok "Firebase"
  else bad "Firebase (firebase projects:list failed)" "firebase login --reauth --no-localhost   # open the printed link on any machine, sign in, paste the code back"; fi
fi

if want gh; then
  if ! has gh; then bad "GitHub: gh is not installed" "install the GitHub CLI"
  elif gh auth status >/dev/null 2>&1; then
    # The account name only: the line "Logged in to github.com account NAME".
    acct=$(gh auth status 2>&1 | sed -n 's/.*account \([A-Za-z0-9-]*\).*/\1/p' | head -1)
    ok "GitHub: ${acct:-signed in}"
  else bad "GitHub (gh auth status failed)" "gh auth login   # choose 'Login with a web browser'; enter the device code at https://github.com/login/device from any machine"; fi
fi

if [ "$failed" -gt 0 ]; then printf 'preflight: %d sign-in(s) need renewing on %s\n' "$failed" "$(hostname -s 2>/dev/null || hostname)"; exit 1; fi
exit 0
