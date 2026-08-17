# Grafana dashboard

`dashboard.json` is a ready-to-import Grafana dashboard for the metrics exposed
at `/metrics` (see the main README's "Health check" section).

## Import

1. Grafana → **Dashboards → New → Import**.
2. Upload `dashboard.json` (or paste its contents).
3. Select your Prometheus datasource when prompted.
4. Set the **Job** dashboard variable to match the `job_name` you used in your
   scrape config (defaults to `wa-courier`).

## Panels

- **Session status** — connected/disconnected, from `wa_courier_connected`.
- **Messages sent (24h)** — total from `wa_courier_messages_sent_total`.
- **Error rate (5m)** — percentage of sends with `status="error"`. Falls back
  to `0` (instead of "No data") when no errors have occurred in the window.
- **Uptime** — process uptime.
- **Messages sent rate by status / by type** — time series broken down by labels.
- **Delivery ack status rate** — `wa_courier_message_ack_total`, recorded from
  WhatsApp delivery-status updates regardless of whether
  `WAC_STATUS_WEBHOOK_URL` is configured (the webhook is a separate,
  fire-and-forget notification, not a prerequisite for the metric). Expect
  "No data" until at least one sent message receives a status update — group
  sends in particular may not report per-participant delivery/read acks the
  way direct messages do.
- **Process memory (RSS)** — from prom-client's default Node.js metrics.

## Prerequisite

Your Prometheus instance needs to be scraping `GET /metrics` on the gateway
(no auth required on that endpoint).

## Job label

Every query in this dashboard filters on `{job="$job"}`. This is required for
the `Uptime` and `Process memory (RSS)` panels: `process_start_time_seconds`
and `process_resident_memory_bytes` are generic metric names exposed by
prom-client's default Node.js collectors, and most Prometheus setups scrape
several unrelated services that expose the same names — without the `job`
filter these panels can silently mix data from a different target sharing the
same generic metric name.
