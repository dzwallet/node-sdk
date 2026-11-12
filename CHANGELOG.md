# Changelog

## 0.2.1

- Fix the Express return URL and handle unknown orders in the webhook example.

## 0.2.0
- Signed notifications v2: `verifyWebhook()`, `verifyNotification()` (raw body, signed timestamp window, unique event id), `parseIpnForm()`
- The older `signature` field is still accepted unless `requireV2` is set

## 0.1.0
- First release
