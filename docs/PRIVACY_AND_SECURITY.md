# PrivAgent Privacy and Security

**This document has moved to [SECURITY.md](./SECURITY.md).**

`SECURITY.md` carries the threat model, the five stated guarantees, the code that enforces
each one, the test that would fail if it regressed, and — importantly — a verification
table distinguishing what has been tested from what has only been designed.

## Regulatory consideration

The architecture supports the data-minimization and local-processing principles relevant to
India's DPDP Act 2023: perception, PII detection and redaction all happen on the user's
device, and only tokenized, task-relevant structured context leaves it.

This is a design consideration, not a legal compliance determination. No legal review has
been performed.
