# Abrir TimeTrack en un Mac por primera vez

> **Beacon Desktop** es el nuevo nombre de TimeTrack (0.9.0). En disco la app conserva su nombre anterior: la
> descarga sigue siendo `TimeTrack_<versión>_universal.dmg`, la app es `TimeTrack.app` en Aplicaciones y los diálogos
> de macOS dicen "TimeTrack": los pasos de abajo no cambian.

TimeTrack para macOS **no está notarizado por Apple**. La notarización exige el Apple Developer Program, que es de
pago, y TimeTrack se distribuye sin coste. Por eso macOS te pide que confirmes **una sola vez** que confías en la app.
Después, TimeTrack se abre como cualquier otra app.

Hazlo solo con una copia descargada de **tu propio Beacon** (Tareas → Tiempo → Apps). Para comprobar la descarga,
compara su SHA-256 con el que muestra esa página:

```sh
shasum -a 256 ~/Downloads/TimeTrack_*_universal.dmg
```

Los textos de los diálogos son los de Apple en el momento de escribir esto. Pueden variar un poco entre versiones de
macOS.

## macOS Sequoia (15) y posteriores

En Sequoia, **Control-clic (clic derecho) → Abrir ya no se salta esta comprobación**. Tienes que usar Ajustes del
Sistema.

1. **Instala.** Abre el `TimeTrack_<versión>_universal.dmg` descargado y arrastra **TimeTrack** a **Aplicaciones**.

   > **[Captura M1 — `docs/guides/images/macos-1-dmg.es.png`]** La ventana del Finder con la imagen de disco abierta,
   > en modo claro: el icono de TimeTrack (la cabeza de la mascota sobre el cuadrado verde musgo) a la izquierda, una
   > flecha y el alias de la carpeta Aplicaciones a la derecha. Recorta a la ventana de la imagen de disco.

2. **Intenta abrirla una vez.** En **Aplicaciones**, haz doble clic en **TimeTrack**. macOS muestra **No se ha abierto
   "TimeTrack"**: *"Apple no ha podido verificar que "TimeTrack" no contenga software malicioso que pueda dañar el Mac o
   poner en riesgo tu privacidad."* Pulsa **OK**. **No** pulses *Trasladar a la papelera*.

   > **[Captura M2 — `docs/guides/images/macos-2-not-opened.es.png`]** El diálogo «No se ha abierto "TimeTrack"» con
   > sus dos botones, **OK** y **Trasladar a la papelera**. Resalta **OK**. Recorta al diálogo.

3. **Permítela en Ajustes del Sistema.** Abre el **menú Apple → Ajustes del Sistema → Privacidad y seguridad**. Baja
   hasta **Seguridad**. Verás *Se ha bloqueado "TimeTrack" para proteger el Mac.* Pulsa **Abrir igualmente**. El botón
   solo aparece después del paso 2, y solo durante un rato (alrededor de una hora). Si no lo ves, repite el paso 2.

   > **[Captura M3 — `docs/guides/images/macos-3-open-anyway.es.png`]** Ajustes del Sistema → Privacidad y seguridad,
   > bajado hasta la sección **Seguridad**: la línea *Se ha bloqueado "TimeTrack" para proteger el Mac.* y el botón
   > **Abrir igualmente**. Resalta el botón. Ventana de unos 800 px de ancho; recorta al panel derecho.

4. **Confirma con tu contraseña.** Escribe la contraseña de inicio de sesión del Mac, o usa Touch ID.

   > **[Captura M4 — `docs/guides/images/macos-4-password.es.png`]** La petición de autenticación (Ajustes del Sistema
   > o «Privacidad y seguridad»), con el campo de contraseña vacío. Recorta a la petición.

5. **Abre.** Un último diálogo pregunta si quieres abrir TimeTrack. Pulsa **Abrir igualmente** (en algunas versiones el
   botón es **Abrir**). TimeTrack arranca y su icono aparece en la barra de menús.

   > **[Captura M5 — `docs/guides/images/macos-5-confirm.es.png`]** El diálogo final de confirmación con el botón
   > **Abrir igualmente** (o **Abrir**) resaltado. Recorta al diálogo.

## macOS Sonoma (14) y anteriores

Funciona cualquiera de estas dos formas:

- **Ajustes del Sistema**, como en Sequoia: intenta abrir TimeTrack una vez, ve a **Ajustes del Sistema → Privacidad y
  seguridad → Abrir igualmente** y confirma.
- **Control-clic**: en **Aplicaciones**, haz Control-clic (o clic derecho) en **TimeTrack** → **Abrir**, y pulsa
  **Abrir** en el diálogo.

  > **[Captura M6 — `docs/guides/images/macos-6-sonoma-control-click.es.png`]** Finder de Sonoma, carpeta
  > Aplicaciones, con el menú contextual abierto sobre TimeTrack y **Abrir** resaltado. Después, el diálogo que ofrece
  > **Abrir** y **Cancelar**. Dos imágenes juntas, o dos archivos (`…-6a…`, `…-6b…`).

## Después de la primera vez

- macOS recuerda tu decisión. Solo lo haces una vez en cada Mac.
- **Las actualizaciones que instala TimeTrack no vuelven a preguntar.** Cuando TimeTrack muestra *«La versión X está
  disponible»* y eliges **Actualizar ahora**, descarga la actualización, comprueba su firma, se sustituye a sí mismo y
  se reinicia, sin ningún aviso de macOS. Es lo esperado por cómo trata macOS los archivos que no ha descargado un
  navegador, pero todavía no se ha comprobado en un Mac real (ver el plan de la versión 0.4.0).
- Si instalas una versión nueva a mano desde un `.dmg` descargado, macOS puede volver a preguntar. Repite los pasos.

## Si macOS dice «"TimeTrack" está dañado y no se puede abrir»

Este mensaje significa que la copia descargada no tiene ninguna firma válida. TimeTrack 0.4.0 y posteriores llevan una
firma ad hoc para evitarlo. Si aun así lo ves, y estás seguro de que el archivo viene de tu Beacon y su SHA-256
coincide, ejecuta esto en Terminal. Quita la marca de descarga solo de esa app:

```sh
xattr -dr com.apple.quarantine /Applications/TimeTrack.app
```

No desactives nunca Gatekeeper para todo el Mac.

## Fuentes

- Soporte de Apple, *Abrir apps de forma segura en el Mac* — https://support.apple.com/es-es/102445
- Soporte de Apple, *Abrir una app de un desarrollador desconocido* — https://support.apple.com/es-es/guide/mac-help/mh40616/mac
- Macworld, cambio de Control-clic en Sequoia —
  https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html
