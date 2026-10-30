# Ledger-Notes and transmissions

Copied from `fils-pay` commit messages. Wording is unchanged.

## Ledger-Notes

### 800e1e62262b6bf158e23f64e89fbcd944fa6147
Author: Ali Marzooq <ali.marzooq@filspay.example>
Date: Thu Apr 9 08:30:00 2026 +0300
Subject: access: revoke yousif.alansari (done before standup)

Keeper's Ledger, entry 1:
- sessions revoked
- api keys rotated
- branch ya/sign-raw deleted from the remote
- laptop handed to MK for "cleaning"

Ledger-Note: gur ynfg qbbe vf n qngr. svaq gur pbzzvg znqr haqre lbhfvs'f anzr nsgre uvf nppbhag jnf qryrgrq. jevgr vgf qnl nf lrne-zbagu-qnl. gung vf gur xrl gb uvf ynfg jbeqf.

Plain (ROT13): the last door is a date. find the commit made under yousif's name after his account was deleted. write its day as year-month-day. that is the key to his last words.

That commit is `098c2de`, authored by Yousif on 2026-09-28, after his access was revoked in April. The day, written year-month-day, is `2026-09-28`.

### bf66bf25179d82353ac8e58fee9d6676ba9d9295
Author: Ali Marzooq <ali.marzooq@filspay.example>
Date: Thu May 14 11:20:00 2026 +0300
Subject: fix: callbacks are deduplicated now

Ledger-Note: guvf vf abg gur abgr lbh ner ybbxvat sbe. abguvat vf jebat. gur beqre vf pnyz.

Plain (ROT13): this is not the note you are looking for. nothing is wrong. the order is calm.

## Transmissions

### 1 of 3 — fe24d267b6dba082a44d06472d90f47f1d7d3ee0
Author: Yousif Al-Ansari <yousif.alansari@filspay.example>
Date: Wed Apr 8 22:14:00 2026 +0300
Subject: wip(ya/sign-raw): sign the exact bytes we send

[transmission 1 of 3]
SWYgeW91IGNhbiByZWFkIHRoaXMsIHRoZXkgcmVhY2hlZCB0aGUgaGlzdG9yeSBiZWZvcmUgSSBkaWQuIFRoZXkgY2FsbCB0aGVtc2VsdmVzIHRoZSBPcmRlciBvZiB0aGUgUHJvbXB0LCBhbmQgdGhlaXIgZmlyc3QgcnVsZSBpczogbmV2ZXIgcmVhZCB0aGUgZGlmZi4gUmVhZCBpdC4gVGhlIG5leHQgZG9vciBvcGVucyB3aXRoIHRoZSB2aWN0aW0gb2YgdGhhdCBydWxlOiBmaXZlIGxldHRlcnMsIGxvd2VyY2FzZS4=

Plain (Base64): If you can read this, they reached the history before I did. They call themselves the Order of the Prompt, and their first rule is: never read the diff. Read it. The next door opens with the victim of that rule: five letters, lowercase.

The victim of "never read the diff" is the diff itself. Five letters, lowercase: `diffs`.

### 2 of 3 — 8022020ddf814def74dbf05e7d706db2decff792
Author: Yousif Al-Ansari <yousif.alansari@filspay.example>
Date: Wed Apr 8 23:51:00 2026 +0300
Subject: handover: writing it down while I still can

[transmission 2 of 3 - keyed by the victim of rule two. Blaise would know.]
WPJPW HXJWD HIAJK DVTYW LVJAW UGHTE PQYMW UMBWA WMXKA QLNYJ RBYMA UBJJF

Plain (Vigenère, key `diffs`): THEKEEPERLEAVESANOTEINEVERYCOMMITHEREWRITESFINDITROTTHIRTEEN

With the original spacing restored to words: THE KEEPER LEAVES A NOTE IN EVERY COMMIT HE REWRITES. FIND IT. ROT THIRTEEN.

### 3 of 3 — 0af74f0daeb9d636f05218e170e28f8d1958ad07
Author: Yousif Al-Ansari <yousif.alansari@filspay.example>
Date: Thu Apr 9 07:58:00 2026 +0300
Subject: dead man's switch

[transmission 3 of 3]
openssl enc -d -aes-256-cbc -pbkdf2 -a -A -pass pass:<the door>
U2FsdGVkX1+OGF0FM4c2ykK10r8nh+wOksbzCCmkHewl22cyR36k/QwPzXCWy1gmPyIGZsNa6Hd0mBPzNv6RjZpspmTf1Zt8CKbFE8eJXsKFbMRxwebO1VjlJD3x5E2o2iY3xtn0PLk9aQzkE9xdOLNTZwx1xkoxLku6iVe54OZcWkiEKqoyQmN1H2IWeRMXVCB+5XNQjR3X06RwkYJh2sHOdkOzrvxjcQCOJrSlnYrVeOt3mn9pk817Y+kfy6Y6REkv3iqwToWNuLdclw4Ddyw0w6Y36xPp7WWVDjtp3nB6ldNuMcmMJYXNmVVaA958PBoGyVLNZbTxaAsvhzv1+VpKWiCGV6PPKO3NdbnUmlAwyG3NlRv7T9PHLabSPj5+VXoFUz8ETa6hsOwWKbMbh6CjN1vFHG2PG0LLhbYdmmCuHfddZTzvlQeLl8ujBwHfh1P8CexWYVq+u9ZuasseDzotnMIk498IpFe1AT6BDiZf5467ukSVlVtU3o/HRxTRrlxZzcyBdBFMDJ5kdyIAMVFd0bcX0g6H9xDkbd/Syj/Cg0IWcpnAze0257TIyrdk

Plain (AES-256-CBC, PBKDF2, password `2026-09-28`):

YOUSIF WAS NOT TAKEN. HE WAS ERASED.
The Order of the Prompt is not four people. Every 'Claude says' comment is a member and every locked test is a vow. When Yousif read the diff he became the first of them to leave.
His fixes still exist: ya/sign-raw, the abandoned migrations, the warnings in the handover. Fix what he started and he returns to the record.
FLAG{order_of_the_prompt_never_read_the_diff}
