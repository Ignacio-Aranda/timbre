# Timbre

Cliente de escritorio no oficial para porteros Fermax DuoxMe / Blue. Avisa en el
ordenador de que llaman a la puerta —aunque el móvil esté en silencio y con los
cascos puestos—, muestra la cámara, permite hablar con el visitante y abrir la
puerta. Para Windows y Linux.

> Proyecto independiente, sin relación con Fermax. Reconstruye el protocolo de la
> app oficial para que puedas usar tu propio portero desde el PC. Úsalo bajo tu
> responsabilidad.

## Por qué existe

La app oficial DuoxMe solo existe para móvil y tiene dos pegas conocidas:

- El aviso es de tipo "llamada": con el móvil en silencio no suena, y no hay forma
  de forzar que suene igualmente.
- Si la sesión ha caducado, la llamada se descarta sin avisar, y con la app en
  segundo plano puedes no enterarte.

Timbre resuelve lo primero reproduciendo su propio tono por la salida de audio del
PC, donde el modo silencio del móvil no interviene.

## Qué hace

- Avisa al llamar, con notificación del sistema y tono propio por los altavoces o
  los cascos del PC.
- Muestra la foto del visitante cuando el portero la envía.
- Reproduce el vídeo en directo de la cámara (WebRTC / mediasoup).
- Permite hablar con el visitante en manos libres.
- Abre la puerta con un botón.
- Permite ver las cámaras y abrir la puerta en cualquier momento, sin esperar a
  que llamen.
- Vive en la bandeja del sistema y puede arrancar al iniciar sesión.

## Compatibilidad

Probado con porteros Fermax DUOX PLUS (familia VEO-XS / VEO-XL WiFi). Otros modelos
compatibles con DuoxMe / Blue deberían funcionar.

## Instalación

No hace falta compilar nada. Descarga el instalador de la última versión desde la
página de [Releases](../../releases).

### Windows

1. Descarga el instalador `Timbre.Setup.X.Y.Z.exe`.
2. Ábrelo y sigue el asistente. La aplicación no está firmada, así que la primera
   vez Windows SmartScreen mostrará un aviso: pulsa **Más información** y luego
   **Ejecutar de todas formas**.

Si prefieres no instalar, usa la versión portable `Timbre.X.Y.Z.exe`, que se
ejecuta directamente.

### Linux

Debian o Ubuntu, con el paquete `.deb`:

```bash
sudo apt install ./timbre_X.Y.Z_amd64.deb
```

Cualquier distribución, con el AppImage:

```bash
chmod +x Timbre-X.Y.Z.AppImage
./Timbre-X.Y.Z.AppImage
```

## Primer uso

Timbre se conecta a tu cuenta de Fermax, igual que la app del móvil. La
configuración se hace una sola vez, desde la propia aplicación, en **Ajustes**.

### 1. Consigue el APK de DuoxMe

Timbre no incluye ninguna credencial de Fermax: las lee de tu propia copia de la
app oficial, que como cliente de pago tienes derecho a usar para interoperar con
tu equipo.

Desde un Android con la app instalada y la depuración USB activada:

```bash
adb shell pm path com.fermax.blue.app
adb pull /data/app/.../base.apk
```

Si `pm path` lista varios `split_config.*.apk`, con `base.apk` es suficiente.
También puedes obtener el APK de una fuente de confianza.

### 2. Configura la cuenta

En **Ajustes**, dentro de Timbre:

1. Selecciona tu `base.apk`. Timbre extrae la configuración de Firebase y las
   credenciales de OAuth.
2. Introduce el correo y la contraseña de tu cuenta de Fermax e inicia sesión.

Hecho: Timbre queda a la escucha en la bandeja del sistema.

### Usuario dedicado (recomendado)

Fermax limita las sesiones activas por cuenta. Si usas tu cuenta principal, el
móvil puede dejar de recibir avisos, o al revés. Lo recomendable es crear un
usuario aparte para el PC:

1. En la app DuoxMe: **Ajustes → Usuarios → Invitar usuario**.
2. Invita a un correo nuevo (los alias de Gmail del tipo `tucorreo+pc@gmail.com`
   sirven).
3. Completa el registro desde el enlace del correo y usa esa cuenta en Timbre.

## Cómo funciona

Timbre se comporta como un dispositivo más de tu cuenta de Fermax:

1. Inicia sesión en la nube de Fermax (OAuth2).
2. Se registra en Firebase Cloud Messaging y entrega su token a Fermax, igual que
   el móvil, para recibir el aviso cuando alguien llama.
3. Al llamar, Fermax envía un aviso con la sala y el servidor de señalización;
   Timbre se conecta por Socket.IO y mediasoup para el vídeo y el audio.
4. La puerta se abre a través de la API de la nube.

El portero habla siempre con la nube de Fermax. Timbre no elimina esa dependencia:
es un cliente alternativo, no un servidor local.

## Compilar desde el código

Solo si quieres compilarlo tú mismo. Necesitas Node.js 22 o superior y npm.

```bash
npm install
npm start
```

Para generar los instaladores:

```bash
npm run dist:win     # Windows: instalador y portable (.exe)
npm run dist:linux   # Linux: .deb y AppImage
```

Los resultados quedan en `dist-build/`. El flujo de integración continua
([`.github/workflows/build.yml`](.github/workflows/build.yml)) compila ambas
plataformas y, al etiquetar una versión `vX.Y.Z`, publica una release con los
instaladores.

## Estructura del proyecto

```
src/main/        Proceso principal de Electron
  apk/           Lectura del APK (ARSC + DEX) y extracción de credenciales
  fermax-api.js  Cliente REST de la nube de Fermax
  push.js        Escucha de avisos por FCM
  store.js       Configuración y credenciales en userData
src/renderer/    Interfaz: ventana de configuración y panel de la bandeja
scripts/         Build del renderer (esbuild) y generación de recursos
test/unit/       Pruebas (node --test)
```

```bash
npm test     # pruebas unitarias
npm run dev  # arranca con las DevTools abiertas
```

Para probar el extractor contra un APK real:

```bash
TIMBRE_TEST_APK=/ruta/base.apk npm test
```

## Privacidad y seguridad

- Las credenciales se guardan solo en tu equipo, en el directorio `userData` de la
  aplicación (`credentials.json`, con permisos restringidos). No se envían a ningún
  sitio salvo a los propios servidores de Fermax.
- El `.gitignore` evita subir por error el APK o las credenciales.
- No publiques nunca tu `credentials.json`, tus tokens ni tu usuario y contraseña.

## Créditos

El trabajo de la comunidad de código abierto fue clave para entender el protocolo:

- [bvis/fermax-blue-hass](https://github.com/bvis/fermax-blue-hass): integración de
  Home Assistant, referencia del flujo de avisos y vídeo.
- [marcosav/fermax-blue-intercom](https://github.com/marcosav/fermax-blue-intercom)
- [AfonsoFGarcia/hass-bluecon](https://github.com/AfonsoFGarcia/hass-bluecon) y
  [cvc90/HASS-BlueCon](https://github.com/cvc90/HASS-BlueCon)

## Aviso legal

Timbre es software independiente, sin afiliación ni respaldo de Fermax. "Fermax",
"DuoxMe" y "Blue" son marcas de sus respectivos titulares. Extraer la configuración
de una aplicación que posees como cliente de pago, para interoperar con tu propio
equipo y uso personal, es un ejercicio legítimo de tus derechos. El protocolo de la
nube de Fermax puede cambiar y dejar de funcionar en cualquier momento.

## Licencia

[MIT](LICENSE) © 2026 Ignacio Aranda
