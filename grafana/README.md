# Grafana dashboard

`dashboard.json` is a ready-to-import Grafana dashboard for the metrics exposed
at `/metrics` (see the main README's "Health check" section).

## Import

1. Grafana → **Dashboards → New → Import**.
2. Upload `dashboard.json` (or paste its contents).
3. Select your Prometheus datasource when prompted.

## Panels

- **Session status** — connected/disconnected, from `wa_courier_connected`.
- **Messages sent (24h)** — total from `wa_courier_messages_sent_total`.
- **Error rate (5m)** — percentage of sends with `status="error"`.
- **Uptime** — process uptime.
- **Messages sent rate by status / by type** — time series broken down by labels.
- **Delivery ack status rate** — `wa_courier_message_ack_total`, requires
  `WAC_STATUS_WEBHOOK_URL` scenarios to be populated (the metric is recorded
  regardless of whether the webhook itself is configured).
- **Process memory (RSS)** — from prom-client's default Node.js metrics.

## Prerequisite

Your Prometheus instance needs to be scraping `GET /metrics` on the gateway
(no auth required on that endpoint).
