# Security Policy

## Philosophy

mythos-router follows a **zero-trust AI model**.

AI outputs are never trusted by default.
All file operations are verified against the actual filesystem before being accepted.

---

## Safe Execution

* Shell command execution is **restricted via a whitelist**
* No arbitrary commands are executed
* Optional `--paranoid` mode disables all shell access completely

---

## Environment Variables

* Sensitive values (e.g. API keys) require explicit configuration
* No implicit defaults are used for security-critical settings

---

## Scope

This tool is designed for **local execution only**.

Users are responsible for:

* reviewing AI-generated actions
* validating changes before applying in production environments

---

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

* X: **[@thewaltero](https://www.x.com/thewaltero)** *(recommended)*
* Or open a private security advisory on GitHub

Please avoid public disclosure until the issue has been reviewed.

---

## Supported Versions

Currently supported:

* Latest version on `main`

Older versions may not receive security updates.

---
