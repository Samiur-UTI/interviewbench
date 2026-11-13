"""Simulator behind cluster-cutover's hidden tests (build contract, section 3).

It reads the candidate's repository at $APP_DIR and evaluates it the way the real components
would: the Halyard firewall, the API server and its RBAC, the kubelets, the dashboard, the
platform Vault, Vault Agent in a payments pod, and the payments service. The payments package
(imported from services/payments) is the only candidate code that ever runs.
"""
