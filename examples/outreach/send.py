#!/usr/bin/env python3
"""
Grayr outreach sender (Resend).

SAFE BY DEFAULT. Running it with no flags only PREVIEWS the composed emails.
It will not contact Resend or send anything unless you pass BOTH --send and --confirm.

  python3 send.py                 # preview all 10 (no network, nothing sent)
  python3 send.py --only Rye      # preview just one
  python3 send.py --send --confirm            # actually send all (requires verified domain in Resend)
  python3 send.py --send --confirm --only Rye # actually send one

Config + secrets come from .env in this directory (gitignored).
"""
import json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))

def load_env():
    env = {}
    with open(os.path.join(HERE, ".env")) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env

DROP_BY = ("I'm in SF for YC Startup School and would love to swing by and show you "
           "the live version if you're around.")
REMOTE = "Happy to send a 2 minute demo or jump on a quick call if you're curious."

def compose(r):
    ask = DROP_BY if r.get("bay_area") is True else REMOTE
    noun = r.get("noun", "platforms")
    body = f"""Hi {r['first']},

I'm Liron, a software engineering student at Waterloo. I've been building Grayr (grayr.xyz), a free layer that sits between an agent and its payment so it can't pay a scam merchant or blow past the rules you set.

{r['hook']}

Right before an agent pays, Grayr checks whether the merchant is legit and whether the payment is inside your rules, and returns a yes or no. It is neutral and works across every rail, so it is not really something you'd want to build and babysit in-house, and it is free for {noun} like yours to drop in. It is live today, settling real payments on Base with the check gating them.

{ask}

Either way, curious what you think.

Liron
grayr.xyz"""
    return r["subject"], body

def send_one(env, to_addr, subject, body):
    payload = {
        "from": f"Liron Katsif <{env['FROM_ADDRESS']}>",
        "to": [to_addr],
        "reply_to": env["REPLY_TO"],
        "subject": subject,
        "text": body,
    }
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {env['RESEND_API_KEY']}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()
    except Exception as e:
        return False, str(e)

def main():
    args = sys.argv[1:]
    do_send = "--send" in args
    confirm = "--confirm" in args
    only = None
    if "--only" in args:
        only = args[args.index("--only") + 1]
    fname = args[args.index("--file") + 1] if "--file" in args else "recipients.json"

    recipients = json.load(open(os.path.join(HERE, fname)))
    if only:
        recipients = [r for r in recipients if r["company"].lower() == only.lower()]
        if not recipients:
            print(f"no recipient named {only}"); sys.exit(1)

    env = load_env()

    if do_send and confirm:
        print(f"!!! LIVE SEND to {len(recipients)} recipient(s) from {env['FROM_ADDRESS']} (reply-to {env['REPLY_TO']})")
        print("    (the sending domain must be verified in Resend or this will fail)\n")
    else:
        print(f"=== PREVIEW ONLY ({len(recipients)} email(s)). Nothing is being sent. ===")
        print("    To actually send: python3 send.py --send --confirm\n")

    for r in recipients:
        subject, body = compose(r)
        drop = "SF drop-by" if r.get("bay_area") is True else ("remote" if r.get("bay_area") is False else "remote (HQ unverified)")
        print("-" * 78)
        print(f"TO: {r['email']}   [{r['company']}, {drop}]")
        print(f"FROM: {env['FROM_ADDRESS']}    REPLY-TO: {env['REPLY_TO']}")
        print(f"SUBJECT: {subject}\n")
        print(body)
        print()
        if do_send and confirm:
            ok, res = send_one(env, r["email"], subject, body)
            print(f"  -> {'SENT' if ok else 'FAILED'}: {res}")
            time.sleep(1.5)

    if not (do_send and confirm):
        print("-" * 78)
        print("Preview complete. No emails were sent.")

if __name__ == "__main__":
    main()
