# Sentinel App — monitor móvil del bot Sentinel

PWA instalable (GitHub Pages, carpeta `docs/`) + puente Cloudflare Worker hacia InfluxDB + build de APK por GitHub Actions.

## Piezas

- `docs/` — la app (HTML/CSS/JS sin dependencias, instalable, responsive).
- `worker/worker.js` — puente solo-lectura. **Sin secretos en el código**: `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` y `READ_KEY` se configuran como Worker Secrets.
- `mobile/` — envoltorio Capacitor (solo se usa en CI para compilar el APK).
- `.github/workflows/build-apk.yml` — compila el APK debug en la nube con cada push a `main`.

## Seguridad

- Ningún token vive en este repo. El token de InfluxDB solo existe como secreto del Worker.
- La PWA solo conoce la URL pública del Worker y una clave de lectura.
- Las acciones del bot (pausar, estado) se hacen por Telegram, no desde la app.

## Instalación en Android

1. Abrir la URL publicada en Chrome.
2. Menú ⋮ → "Añadir a pantalla de inicio" / "Instalar app".
3. O instalar el APK de la pestaña Releases (permitir apps desconocidas).
