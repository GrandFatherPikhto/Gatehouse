# SingBoxWebUI — ядро генератора конфига sing-box

Этот репозиторий содержит **ядро генерации** инструмента для sing-box: чтение
настроек, разбор VLESS-ссылок подписки, валидацию и сборку `config.json`,
**побайтово совпадающего** с выводом эталонной питоновой реализации
([`SingBoxTools/sing_box_manager.py`](https://example.invalid/SingBoxTools/sing_box_manager.py)).

Это порт, а не переписывание. У эталона три года эксплуатации и 79 тестов,
поэтому первый шаг — точное совпадение, а не улучшения. Всё, что в эталоне
выглядит странно, описано в
[`techdocs/done_2026_09_14_port_core_generator.md`](techdocs/done_2026_09_14_port_core_generator.md),
а не «поправлено» по дороге.

**Веб-сервера здесь нет.** Ни Express, ни маршрутов, ни HTML, ни браузерного
кода: веб-морда — следующая задача, она строится поверх проверенного ядра.
Единственные точки входа — утилиты CLI ниже.

## Требования

* Node **22** (мажорная версия закреплена в `.nvmrc`; проверено на 22.23.2 с
  npm 10.9.8 — те же версии, что на роутере)
* npm (для `ajv`; `yaml` нужен только одноразовому конвертеру)
* Python с PyYAML — **только** для необязательного побайтового сравнения с
  эталоном; самим тестам Python не нужен

## Установка и тесты

```bash
npm ci          # ставит ajv (runtime) и yaml (конвертер, dev)
node --test     # 137 проверок, без сети, root и sing-box
```

`node --test` находит `tests/*.test.mjs` и создаёт все временные файлы в
системном каталоге временных файлов: прогон никогда не трогает репозиторий,
рабочий `webui.json` или `config.json`.

## Использование

```bash
# собрать config.json рядом с webui.json
node tools/generate.mjs --settings webui.json

# переопределить вывод, файл ссылок, адрес прослушивания или активный профиль
node tools/generate.mjs --settings webui.json \
    --output /etc/sing-box/config.json \
    --links server-lists/vpnd.vless.reality.io.txt \
    --listen-ip 10.95.2.1 \
    --profile reality
```

| Флаг | Смысл |
| --- | --- |
| `--settings PATH` | файл настроек, по умолчанию `webui.json` |
| `--profile NAME` | профиль вместо `active` |
| `--output PATH` | куда писать `config.json` (переопределяет `output_file`) |
| `--links PATH` | файл ссылок (переопределяет `links_file`) |
| `--listen-ip IP` | адрес прослушивания (переопределяет `listen_ip`) |
| `--exclude-from-auto PREFIX...` | префиксы тегов, выкидываемые из `auto-select` |
| `--warnings-file PATH` | записать собранные предупреждения в JSON |
| `--quiet` | не печатать сводку |

Относительные пути внутри файла настроек резолвятся относительно каталога этого
файла, поэтому утилиту можно запускать из любого рабочего каталога. Код возврата
0 при успехе и 1 при любой ошибке конфигурации, причина — в stderr.

## Формат настроек: `webui.json`

`settings.yaml` заменён на `webui.json`. YAML ушёл сознательно: файл больше не
правят руками, поэтому сохранение комментариев (единственная причина, по которой
в питоновом проекте жил `ruamel`) перестало быть требованием. Файл проверяется
по [`src/schemas/webui.schema.json`](src/schemas/webui.schema.json) через `ajv`
при каждой загрузке.

```json
{
  "version": 1,
  "active": "reality",
  "defaults": {
    "listen_ip": "10.95.2.1",
    "log": { "level": "info", "timestamp": true },
    "urltest": { "url": "https://gstatic.com", "interval": "3m", "tolerance": 50 },
    "dns": { "servers": [], "rules": [], "final": "dns-local" }
  },
  "profiles": {
    "reality": {
      "note": "Reality-транспорт, основной",
      "links_file": "server-lists/vpnd.vless.reality.io.txt",
      "output_file": "/etc/sing-box/config.json",
      "exclude_from_auto": ["🇷🇺"],
      "proxies": [
        { "tag": "main", "type": "mixed", "port": 54321, "note": "",
          "servers": ["🇫🇮 Finland - Helsinki 1"] }
      ],
      "routes": {
        "telegram": { "outbound": "🇫🇮 Finland - Helsinki 1",
                      "domains": ["telegram.org", "t.me"] }
      }
    }
  }
}
```

Правила формата:

* **активен ровно один профиль.** Два профиля применить одновременно нельзя: у
  них пересекаются порты, а sing-box один. `active` обязателен и должен
  указывать на существующий профиль — иначе `ajv` отвергает файл через
  собственное ключевое слово `profileMustExist`, потому что JSON Schema не умеет
  выразить «`active` обязан быть ключом `profiles`».
* **ключ профиля перекрывает одноимённый ключ `defaults`**, только на верхнем
  уровне. Вложенные `log`/`dns`/`urltest` заменяются целиком — ровно так же, как
  вёл себя эталон с плоским YAML.
* **`note` — комментарий для человека**: и у профиля, и у прокси. Ядро его
  игнорирует, в `config.json` он не попадает.
* **типы прокси — `socks`, `http`, `mixed`**, заданы в одном месте
  ([`src/core/errors.mjs`](src/core/errors.mjs:1), `PROXY_TYPES`) и повторены в
  `enum` схемы; тест падает, если они разойдутся.
* **схема дополняет ядро, а не заменяет его.** Дубли тегов и портов невозможно
  выразить в JSON Schema, поэтому ловит их только `validate_proxies`.
* `webui.json` и любые `*.txt` отрезаны `.gitignore`: в них личные списки.
  Единственный закоммиченный файл ссылок — синтетическая фикстура
  `tests/fixtures/links.txt`.

## Переезд с `settings.yaml`

Конвертер одноразовый и единственное место, где разрешён пакет `yaml`:

```bash
node tools/import-settings.mjs --settings settings.yaml --output webui.json
# оставить реальный файл ссылок на месте, ничего не копируя:
node tools/import-settings.mjs --settings /srv/sing-box/settings.yaml \
    --output /tmp/webui.json --absolute-paths
```

Он переносит известные ключи в профиль `default`, сообщает о неизвестных ключах
вместо того чтобы молча их выбросить, а `--absolute-paths` переписывает
`links_file`/`output_file` абсолютными путями относительно каталога YAML.

## Побайтовая приёмка против эталона

```bash
npm run compare                                    # фикстуры репозитория
node tools/compare-with-python.mjs --yaml /srv/sing-box/settings.yaml
```

Утилита запускает эталон и порт на одних данных и сравнивает два `config.json`
побайтово, печатая первую расходящуюся строку с контекстом. Эталонный проект
только читается: он вызывается с абсолютным путём `--settings` и пишет во
временный каталог.

Проверок два уровня:

1. **автоматическая, без Python** — `tests/build.test.mjs` сравнивает собранный
   конфиг с закоммиченным `tests/fixtures/expected-config.json`, который один
   раз сгенерирован эталоном и пересобирается командой выше;
2. **ручная, на реальных данных** — команда выше на рабочем `settings.yaml`
   владельца (148 серверов, эмодзи в тегах, шесть инбаундов). Оба прогона сейчас
   дают идентичные байты; см. отчёт в `techdocs/`.

## Структура проекта

| Путь | Роль |
| --- | --- |
| [`src/core/vless.mjs`](src/core/vless.mjs:1) | `getFirst`, `parseVless`, `dedupTags`, `parseLinks` |
| [`src/core/validate.mjs`](src/core/validate.mjs:1) | `asList`, `requireMapping`, `validateProxies`, `urltestBlock`, `validateExclude` |
| [`src/core/build.mjs`](src/core/build.mjs:1) | `buildInbounds`, `buildPools`, `buildRules`, `buildConfig` |
| [`src/core/settings.mjs`](src/core/settings.mjs:1) | загрузка `webui.json`, проверка ajv, слияние профиля, `resolvePath`, `writeJson`, `generateConfigFile` |
| [`src/core/errors.mjs`](src/core/errors.mjs:1) | `ConfigError`, `PROXY_TYPES`, `DEFAULT_EXCLUDE` |
| [`src/schemas/webui.schema.json`](src/schemas/webui.schema.json:1) | JSON-схема файла настроек |
| [`tools/generate.mjs`](tools/generate.mjs:1) | CLI, который пишет `config.json` |
| [`tools/import-settings.mjs`](tools/import-settings.mjs:1) | одноразовый конвертер `settings.yaml` → `webui.json` |
| [`tools/compare-with-python.mjs`](tools/compare-with-python.mjs:1) | побайтовое сравнение с эталоном |
| [`tests/`](tests/helpers.mjs:1) | набор `node:test`, фикстуры и таблица покрытия |
| [`techdocs/`](techdocs/port-coverage.md:1) | заметки о порте, проба URL, таблица покрытия, отчёт |

## Заметки о порте

* **Предупреждения — это данные, а не stderr.** Эталон часть проблем печатал
  (маршрут на неизвестный outbound, отсутствующая секция `dns`, непарсящаяся
  ссылка) и продолжал работу. Порт собирает их в массив, который возвращается
  вместе с конфигом, чтобы будущая веб-морда могла их показать; CLI печатает их
  в stderr в формулировках эталона.
* **В ядре нет YAML.** YAML трогает только `tools/import-settings.mjs`, поэтому
  пакет `yaml` лежит в `devDependencies`.
* **Зависимости остаются на уровне `ajv`.** Ни фреймворка, ни lodash, ни раннера
  тестов: в Node 22 есть всё нужное. TypeScript тоже нет — типы через JSDoc.
* **Интерактивного пикера нет намеренно.** `pick_proxy`, `filter_and_select`,
  `ask_wqx` и `main()` эталона не портируются, их место занимает будущая
  веб-морда.
* **`curl_test` и `live_test` не вернутся.** `live_test` ради проверки одного
  сервера переписывал `config.json` и рестартовал sing-box — 149 рестартов на
  148 серверов, каждый рвёт все соединения в доме. Проверенная замена, уже
  используемая на роутере:

  ```bash
  sing-box tools fetch -c /etc/sing-box/config.json -o "🇨🇾 Cyprus - Limassol" https://ipinfo.io
  ```

  Она завершается за секунду с кодом 0 и не трогает работающий sing-box.
  Веб-морда будет использовать именно её; в этой задаче из неё не реализовано
  ничего.
