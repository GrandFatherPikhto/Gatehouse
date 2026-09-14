# Развёртывание SingBoxWebUI на роутере

Это **заготовки и порядок действий**, а не установщик. Ни один файл отсюда не
применяется автоматически: команды выполняет владелец руками. Всё описано для
машины, где код лежит в `/home/denis/sing-box-web-ui`, нода системная
(NodeSource, 22.23.2), а демон `sing-box` управляется systemd-юнитом
`sing-box.service`.

## 0. Что решить до начала

Два вопроса из задания, на которые этот файл не даёт ответа за владельца:

1. **Где лежит код.** В заготовках он в `/home/denis/sing-box-web-ui`. Из-за
   этого `ProtectHome=yes` включить нельзя: сервис перестанет видеть собственные
   файлы и не запустится. Варианты:
   * оставить код в домашнем каталоге и `ProtectHome` не включать — проще, но
     домашний каталог целиком остаётся виден процессу;
   * перенести код в `/opt/sing-box-web-ui`, тогда можно включить
     `ProtectHome=yes`, а в юните поправить `WorkingDirectory` и `ExecStart`.
2. **Как давать право на рестарт.** Два равнозначных варианта, оба лежат здесь:
   * `sudoers.d-singbox-webui` + `sing-box-webui.service` — привычнее, но
     `NoNewPrivileges=yes` включить нельзя: он блокирует setuid, то есть ломает
     `sudo`, а с ним и рестарт;
   * `polkit/10-sing-box-webui.rules` + `sing-box-webui.service.polkit` — sudo не
     нужен вовсе, `NoNewPrivileges=yes` включается, правило узкое (ровно
     `restart` ровно `sing-box.service`).

   Смешивать их не нужно: выберите один.

## 1. Предварительные требования

* Node **22** системная (NodeSource). Проверить: `node --version` → `v22.23.2`.
* Пакеты поставлены **от имени владельца, не root**: `sudo` тут не нужен и
  мешает, потому что `npm ci` пишет `node_modules`, а запускать сервис будет
  `denis`, и от прав на этот каталог зависит работоспособность.
* Каталоги под состояние и конфигурацию создаёт systemd (см. ниже) — руками их
  создавать не надо, кроме `/etc/sing-box-webui` для `env`, если выбран этот
  порядок.

## 2. Подготовка кода

```bash
cd /home/denis/sing-box-web-ui
npm ci --prefer-offline       # .npmrc ставит maxsockets=2: холодный ci иначе
                              # уходит в ETIMEDOUT
node --test                   # 219 прежних + тесты этапа 3, без сети и root
```

`npm ci` — не `npm install`: на роутере нужен воспроизводимый набор из
`package-lock.json`. Перед установкой полезно убедиться, что `node_modules`
принадлежит `denis`, а не `root`: смешанные права ломают следующий `npm ci`.

## 3. Файлы конфигурации

```bash
# каталог конфигурации и секреты
sudo install -d -m 0750 -o denis -g denis /etc/sing-box-webui
sudo cp deploy/sing-box-webui.env.example /etc/sing-box-webui/env
sudo chown root:denis /etc/sing-box-webui/env
sudo chmod 0640 /etc/sing-box-webui/env
sudoedit /etc/sing-box-webui/env          # вписать токен: openssl rand -hex 32
```

`webui.json` редактор создаст сам при первом сохранении по пути
`SINGBOX_WEBUI_SETTINGS`. Права на него редактор выставляет сам (0600), но
каталог `/etc/sing-box-webui` должен принадлежать `denis`.

**Токен обязателен при привязке к LAN.** Если `SINGBOX_WEBUI_HOST` не адрес
обратной петли, а `SINGBOX_WEBUI_TOKEN` пуст, сервер **откажется стартовать** —
это не предупреждение в логе, а отказ. Проверить:

```bash
SINGBOX_WEBUI_HOST=10.95.2.1 SINGBOX_WEBUI_TOKEN= node src/web/server.mjs
# → Ошибка: отказ запуска: SINGBOX_WEBUI_HOST=10.95.2.1 — не адрес обратной петли,
#   а SINGBOX_WEBUI_TOKEN пуст. ...
#   код возврата 1
```

## 4. Права на /etc/sing-box

Сейчас демон читает конфиг, который лежит `664`, то есть читается всеми
пользователями системы, а в нём ключи VLESS. Привести к разумному:

```bash
sudo chown root:root /etc/sing-box
sudo chmod 750 /etc/sing-box              # каталог: чтение и вход только root и группе
sudo chmod 640 /etc/sing-box/config.json  # файл: чтение root и группе
sudo chown root:root /etc/sing-box/config.json
```

Учтите принадлежность группы: если демон работает не от root, файл должен быть
читаем его группой. Подставьте свою группу вместо `root` в `chown` и убедитесь,
что у неё есть право на чтение каталога (`x`).

Редактор пишет `config.json` от имени `denis`. Поэтому либо `denis` должен
иметь право записи в каталог (например, общая группа с правом `rwx`), либо
генерация выполняется в другой каталог и файл перекладывается отдельно. В
заготовке юнита `SINGBOX_WEBUI_CONFIG=/etc/sing-box/config.json`, а `output_file`
в `webui.json` должен указывать туда же.

## 5. systemd

Вариант с sudo (по умолчанию):

```bash
sudo cp deploy/sing-box-webui.service /etc/systemd/system/
sudo install -m 0440 -o root -g root deploy/sudoers.d-singbox-webui /etc/sudoers.d/sing-box-webui
sudo visudo -c                            # ОБЯЗАТЕЛЬНО: сломанный файл ломает sudo целиком
sudo systemctl daemon-reload
sudo systemctl enable --now sing-box-webui
systemctl status sing-box-webui --no-pager
```

Вариант с polkit:

```bash
sudo cp deploy/sing-box-webui.service.polkit /etc/systemd/system/sing-box-webui.service
sudo install -m 0644 deploy/polkit/10-sing-box-webui.rules /etc/polkit-1/rules.d/
sudo systemctl restart polkit
sudo systemctl daemon-reload
sudo systemctl enable --now sing-box-webui
```

Проверка правила полномочий (от имени `denis`):

```bash
# sudo-вариант
sudo -n systemctl restart sing-box && echo ok

# polkit-вариант
systemctl restart sing-box
```

## 6. Проверка редактора

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://10.95.2.1:8080/
# 401 — это правильный ответ без токена
curl -sS -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $TOKEN" http://10.95.2.1:8080/
# 200
```

Порядок работы в интерфейсе: «Вывод» → «Сохранить» → «Сгенерировать», затем
«Система» → «Проверить config.json» → и только после успешной проверки
«Перезапустить sing-box». Перед каждой генерацией предыдущий `config.json`
копируется в `<state-dir>/snapshots/config-<метка>.json` (последние 10), откат —
кнопкой «Вернуть предыдущий конфиг и перезапустить».

## 7. Осознанные ограничения

* **`UMask=0027` обязателен.** На роутере umask `0002`: без этой строки снапшоты
  и `config.json` родятся читаемыми для всех, а на машине есть второй аккаунт с
  шеллом (`git`, uid 1001). Проверено.
* **Режимы каталогов заданы явно.** По умолчанию systemd создаёт
  `StateDirectory` с `0755`; в заготовке стоит `StateDirectoryMode=0700`, потому
  что в этом каталоге лежат снапшоты с ключами владельца.
* **`ProtectHome` и `NoNewPrivileges`** разобраны в разделе 0; ни один из них не
  включается «на всякий случай» без переноса кода (первый) или без polkit
  (второй).
* **Порт 80 занят.** На роутере `0.0.0.0:80` уже слушает чужой процесс, поэтому
  редактор по умолчанию и слушает `8080`, и привязывается к LAN-адресу
  `10.95.2.1`, а не к `0.0.0.0`. Не переносите его на 80-й: он занят, и
  «освободить» его — это остановить другой сервис.
* **HTTPS здесь нет.** Никакой терминации своими руками: если она понадобится,
  это ssh-туннель (`ssh -L 8080:127.0.0.1:8080 denis@10.95.2.1`) или внешний
  прокси. По открытому HTTP токен идёт по локальной сети без шифрования: привязка
  к LAN с токеном — удобство, а не защита от прослушивания.
* **Один экземпляр — одна вкладка.** Состояние (открытый файл, правки) живёт на
  сервере; две вкладки будут затирать правки друг друга.
