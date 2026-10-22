# Plugins para Claude Code

[English](README.md) · **Español**

Dos mods para la terminal de Claude Code.

- **usage-meter**: una línea con tokens y costo encima del prompt, y un panel con el uso de esta sesión y de las últimas 24 horas a 90 días de Claude Code y Codex.
- **paste-viewer**: vista previa de las imágenes que pegas al pasar el cursor, y un panel que muestra completos los prompts largos que pegas.

![El panel de usage-meter junto a una sesión de Claude Code, cambiando entre costo de 30 días, tokens, actividad de 90 días y límites](assets/usage-meter.gif)

## Instalación

En el prompt de una sesión de Claude Code en la terminal:

```
/plugin install usage-meter --marketplace anthonyamaro15/claude-code-plugins
/plugin install paste-viewer --marketplace anthonyamaro15/claude-code-plugins
```

Responde `y` para agregar el marketplace y luego elige un alcance (con el alcance de usuario, el mod se carga en todas las sesiones). El mod empieza a funcionar de inmediato.

Desde una shell:

```
claude plugin install usage-meter --marketplace anthonyamaro15/claude-code-plugins
claude plugin install paste-viewer --marketplace anthonyamaro15/claude-code-plugins
```

Para actualizar después: `claude plugin update usage-meter` (o `paste-viewer`) y luego `/reload-plugins`.

## Requisitos

- Una versión reciente de Claude Code que admita mods. Se hicieron y probaron en 2.1.304 y 2.1.305.
- Se recomienda la interfaz de terminal a pantalla completa (`tui: fullscreen`). Con ella, el panel de uso se acopla a la derecha y funcionan las vistas previas al pasar el cursor.
- `python3` en tu `PATH`, solo para el historial de 24h a 90d de usage-meter. La línea del medidor y la vista Session funcionan sin él.

## usage-meter

Una línea encima del prompt muestra los tokens y el costo de esta sesión. `/usage-meter` abre el panel:

- **Session**: costo, tokens, una gráfica por turno y el costo por tipo (entrada, salida, lecturas de caché y escrituras de caché).
- **24h, 7d, 30d, 90d**: historial tomado de los registros de sesión de esta computadora, desglosado por modelo o por día y separado entre Claude Code y Codex. 90d agrega un calendario de actividad diaria.
- **Limits**: cuánto llevas usado de tus límites de 5 horas y semanal, y a qué ritmo vas.

Comandos:

| Comando | Qué hace |
| --- | --- |
| `/usage-meter` | Abre o cierra el panel |
| `/usage-meter cost 30d` | Abre en una vista: `cost`, `tokens` o `limits`, y `session`, `24h`, `7d`, `30d` o `90d` |
| `/usage-meter font blocky` | Fuente del número principal: `smooth`, `rounded`, `bold` o `blocky` |
| `/usage-meter bg #0d1117` | Fondo del panel: un color hex, `none` o `default` |

La fuente y el fondo que elijas se guardan entre sesiones.

**Privacidad**: el historial se lee solo de archivos locales: `~/.claude/projects` (o `$CLAUDE_CONFIG_DIR/projects`) y, si tienes Codex instalado, `~/.codex/sessions` (o `$CODEX_HOME/sessions`). No se envía nada a ningún lado. Las sumas se guardan en caché en `~/.cache/usage-meter/`.

**Precios**: los costos usan los precios de lista de la API que vienen en `usage-meter/scripts/scan.py`, así que muestran lo que costaría ese mismo uso en la API, no lo que cobra una suscripción. Los modelos sin precio conocido se cuentan en tokens y se marcan como sin precio.

## paste-viewer

- Las imágenes que pegas aparecen como una línea tenue "1 image · hover to preview" debajo de tu mensaje. Pasa el cursor sobre ella para ver la imagen.
- Un prompt largo que pegas (más de 12 líneas o 1200 caracteres) muestra debajo un enlace "View N lines" que abre un panel con el texto completo. `/pastes` abre el más reciente, y desde el panel puedes recorrer todos los prompts largos que pegaste en esta sesión.

## Desarrollo

Cada mod es una carpeta con `.claude-plugin/plugin.json` y un módulo de hooks en `hooks/register.tsx`. Para correr uno desde una copia local:

```
claude --plugin-dir ./usage-meter
```

Verificaciones:

```
claude plugin validate ./usage-meter
claude plugin test ./usage-meter
python3 -I usage-meter/scripts/scan_check.py
```

## Licencia

MIT
