# server-mgmt

Forge tab for running the FortiNAC v3 dev stack. Wraps `build-tools/up.sh` (docker compose for `mariadb`, `redis`, `campusmgr`, `web-server`) and `build-tools/scripts/start-web-server.sh` (bare-metal `java -jar` launcher) so you can up/down/rebuild/log services and see live container health from a single tab. Commands are injected into the bound tmux terminal so you see compose output as it happens; container state comes from `docker compose ps --format json`.
