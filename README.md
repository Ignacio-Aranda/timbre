# 🔔 Timbre

**Cliente de escritorio no oficial para porteros Fermax DuoxMe / Blue.**
Entérate de que llaman a la puerta desde el ordenador —aunque tengas el móvil en
silencio y los cascos puestos— y abre sin levantarte. Para **Windows** y **Linux**.

> Proyecto independiente, sin relación con Fermax. Reconstruye el protocolo de la
> app oficial para que puedas usar tu propio portero desde el PC. Úsalo bajo tu
> responsabilidad.

---

## Por qué

La app oficial DuoxMe solo existe para móvil, y tiene un par de pegas conocidas:

- **El tono es de tipo "llamada".** Con el móvil en silencio no suena, y no hay
  forma de dejarlo configurado para que suene igualmente.
- **Si la sesión ha caducado, la llamada se descarta sin avisar.** Con la app en
  segundo plano puedes no enterarte hasta el día siguiente.

Timbre resuelve lo primero de raíz: **reproduce su propio tono por la salida de
audio del PC** (tus cascos), donde el "modo silencio" del móvil no pinta nada.

## Qué hace

- 🔔 **Aviso al llamar** — notificación del sistema **y tono propio por los cascos**.
- 📸 **Foto del visitante** cuando el portero la envía.
- 🎥 **Vídeo en directo** de la cámara del portero (WebRTC/mediasoup).
- 🎙️ **Hablar con el visitante** (manos libres desde el PC).
- 🔓 **Abrir la puerta** con un botón.
- 🖥️ **Vive en la bandeja del sistema** y arranca al iniciar sesión.

## Cómo funciona

Timbre se comporta como un dispositivo más de tu cuenta Fermax:

1. Inicia sesión en la nube de Fermax (OAuth2) con tu cuenta.
2. Se registra en Firebase Cloud Messaging y entrega su token a Fermax, igual que
   hace el móvil, para recibir el aviso cuando alguien llama.
3. Al llamar, Fermax envía un *push* con la sala y el servidor de señalización;
   Timbre se conecta por Socket.IO + mediasoup para el vídeo y el audio.
4. La puerta se abre con la API de la nube (`directed-opendoor` / `incall/opendoor`).

> **Importante:** el portero habla siempre con la nube de Fermax. Timbre **no**
> elimina esa dependencia; es un cliente alternativo, no un servidor local.

## Requisitos

- **Node.js 22+** y **npm** (para compilar desde el código).
- Tu propia copia del **APK de DuoxMe** (para leer la configuración; ver abajo).
- Un portero Fermax compatible con DuoxMe / Blue (probado con la familia
  VEO-XS/VEO-XL WiFi DUOX PLUS).

## Puesta en marcha

### 1. Consigue el APK (una sola vez)

Timbre **no incluye** ninguna credencial de Fermax. Las lee de tu propia copia de
la app, que como cliente de pago tienes derecho a usar para interoperar.

Desde un Android con la app instalada y la depuración USB activada:

```bash
adb shell pm path com.fermax.blue.app
adb pull /data/app/.../base.apk
```

(Si `pm path` lista varios `split_config.*.apk`, con `base.apk` basta para las
credenciales.) También puedes bajar el APK de una fuente de confianza.

### 2. Instala y arranca

```bash
npm install
npm start
```

En la ventana de Timbre:

1. **Paso 1 — Seleccionar APK:** elige tu `base.apk`. Timbre extrae Firebase y las
   credenciales OAuth y verifica las URLs de producción.
2. **Paso 2 — Tu cuenta:** introduce correo y contraseña de Fermax e inicia sesión.

Listo: Timbre queda a la escucha en la bandeja. Pulsa **Probar llamada** para ver
la ventana de llamada sin esperar a que llamen de verdad.

### Usuario dedicado (recomendado)

Fermax **limita las sesiones activas por cuenta**. Si usas tu cuenta principal, el
móvil puede dejar de recibir avisos (o viceversa). Crea un usuario aparte para el PC:

1. En la app DuoxMe: **Ajustes → Usuarios → Invitar usuario**.
2. Invita a un correo nuevo (los alias `tucorreo+pc@gmail.com` de Gmail valen).
3. Completa el registro desde el enlace del email y usa esa cuenta en Timbre.

## Compilar instaladores

```bash
npm run dist:win      # Windows: instalador NSIS + portable (.exe)
npm run dist:linux    # Linux: AppImage + .deb
```

Los artefactos quedan en `dist-build/`. El flujo de CI
([`.github/workflows/build.yml`](.github/workflows/build.yml)) compila ambos y,
al etiquetar `vX.Y.Z`, publica una release con los instaladores.

## Desarrollo

```
src/main/        Proceso principal de Electron
  apk/           Lectura de APK (ARSC + DEX) y extracción de credenciales
  fermax-api.js  Cliente REST de la nube Fermax
  push.js        Escucha de avisos por FCM
  store.js       Configuración y credenciales en userData
src/renderer/    Ventanas (home = configuración, call = llamada con vídeo)
scripts/         Build del renderer (esbuild) y generación de assets
test/unit/       Pruebas (node --test)
```

```bash
npm test     # pruebas unitarias
npm run dev  # arranca con DevTools
```

Para probar el extractor contra un APK real:

```bash
TIMBRE_TEST_APK=/ruta/base.apk npm test
```

## Privacidad y seguridad

- Las credenciales se guardan **solo en tu equipo**, en el directorio `userData`
  de la app (`credentials.json`, con permisos restringidos). No se envían a ningún
  sitio salvo a los propios servidores de Fermax.
- El `.gitignore` evita subir por error APKs o credenciales.
- Nunca publiques tu `credentials.json`, tokens, usuario o contraseña.

## Créditos

El trabajo de la comunidad de código abierto hizo posible entender el protocolo:

- [bvis/fermax-blue-hass](https://github.com/bvis/fermax-blue-hass) — integración de
  Home Assistant, referencia del flujo de avisos y vídeo.
- [marcosav/fermax-blue-intercom](https://github.com/marcosav/fermax-blue-intercom)
- [AfonsoFGarcia/hass-bluecon](https://github.com/AfonsoFGarcia/hass-bluecon) y
  [cvc90/HASS-BlueCon](https://github.com/cvc90/HASS-BlueCon)

Si Timbre te resulta útil, considera dar una estrella también a esos proyectos.

## Aviso legal

Timbre es software independiente, sin afiliación ni respaldo de Fermax. "Fermax",
"DuoxMe" y "Blue" son marcas de sus respectivos titulares. Extraer la configuración
de una app que posees como cliente de pago, para interoperar con tu propio equipo y
uso personal, es un ejercicio legítimo de tus derechos como consumidor. El protocolo
de la nube de Fermax puede cambiar y dejar de funcionar en cualquier momento.

## Licencia

[MIT](LICENSE) © 2026 Ignacio Aranda
