# Codex: совместимость и границы исследования Alpha 1

Квалификация prerequisite адаптера: 2026-10-11. Текущая среда: Blueprint `0.1.0-alpha.1`, Electron `44.7.0`, bundled Node `24.20.0`, MCP SDK server `2.3.1`, guideVersion `0.1.0-alpha.1+guide.5`, macOS `27.0` (`26A428`), Codex CLI `0.162.1`. Исторические результаты ниже помечены отдельно.

Этот документ различает возможности внешнего API и проверенную интеграцию. Текущий цикл Alpha 1 использует явный Save состояния артефакта; оператор выбирает исполнителя, копирует уведомление и сам вставляет/отправляет его в терминале; originSession остаётся авторской связью. Старые Submit-пакеты остаются читаемыми. Автоматическая доставка отключена. Проверки используют одноразовые проекты, данные приложения и task-owned loopback endpoints; пользовательская конфигурация, skills, hooks и существующие рабочие сессии не изменялись. Историческая проверка модели в конце документа относится к прежнему циклу Submit. Текущий Save-цикл и доставка instructions имеют отдельные проверки.

## Квалификация owned backend и настоящего TUI (2026-10-11)

Официальный App Server и сгенерированные схемы установленного `codex-cli 0.162.1` проверены до реализации. На отдельном HOME/CODEX_HOME и одноразовом проекте запущены собственный backend и настоящий remote CLI TUI в PTY; использован локальный Responses-провайдер без credentials, Authorization и внешнего вызова модели. Точный новый thread.id наблюдался в ответе на thread/start именно TUI, а Resume показал тот же persisted ID и предыдущий вывод. Автоматический title-thread и произвольный thread/started не используются как идентичность. Дополнительно checked structured list/read. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

В исходном prerequisite gate реальный изолированный Blueprint, его production stdio bridge и get_blueprint_guide были подключены параметрами конкретного запуска. Инструкция реально появилась в запросе к локальному провайдеру. Отдельный product-manager probe проверил собственный authenticated gateway, новый TUI, list/read после остановки backend и точный Resume на новом backend; MCP peer в этом probe был контролируемым fixture, не финальным HTTP runtime Blueprint. Эти результаты нельзя объединять в неподтверждённую сквозную приёмку нового приложения.

Артефакты (checkout-local, не в Git):

- `.tmp/tasks/harness-workspaces-20261011/codex-gate/result.json`, `report.md`, `wire.json`, `tui-new.txt`, `tui-resume.txt`: `passed:true`, настоящие New/Resume TUI и реальный прежний Blueprint MCP.
- `.tmp/tasks/harness-workspaces-20261011/codex-gate/manager-product/result.json`: `passed:true`, реальный CodexManager/gateway с controlled MCP/local provider.
- `.tmp/tasks/harness-workspaces-20261011/codex-gate/schema/ClientRequest.json`: установленный контракт metadata параметров. thread/list поддерживает `useStateDbOnly:true`; archived=false/null и true — отдельные непересекающиеся фильтры. thread/read не имеет useStateDbOnly и вызывается с includeTurns=false.

Прежние approval/sandbox/model/provider/trust/MCP настройки сохранились, launch-only MCP/provider overrides не записались. Нативный Codex сам добавил в одноразовый config UX bookkeeping `[tui].screen_reader_detection_done` и `[tui.model_availability_nux]`; весь config не объявляется побайтно неизменным. Реальная пользовательская конфигурация, auth и рабочие сессии не использовались и не редактировались. Task-owned backend/TUI/fixture процессы остановлены после эксперимента.

Тесты `tests/codex.test.ts` проверяют metadata пагинацию всех providers и самостоятельных source kinds, archived/non-archived без repair/start/resume, исключение субагентов по parentThreadId/source.subAgent (также после прямого чтения и owned Resume), exact new/fork Resume, неправильный ID, token/Origin отказ, отдельную отмену запуска и Quit во время старта. Это controlled protocol boundary; совместимость настоящего TUI подтверждается отдельными probes выше. Статус чужого CLI остаётся unknown, известные собственные процессы имеют подтверждённую liveness; idle/active/error привязаны к exact thread event. Root session ID и thread.id не подменяются друг другом.

## Текущий transport и сквозная приёмка

Реализация переводит runtime на authenticated Streamable HTTP по динамическому порту `127.0.0.1`; stdio bridge сохраняется и проверяет descriptor protocolVersion/instanceId. Descriptor содержит URL/token, записывается атомарно в private runtime directory с mode 0600 на macOS. Host/Origin отклоняются до MCP; внешний browser не получает CORS. Operator actions и PTY используют private Electron IPC и отсутствуют в public MCP. BLUEPRINT_SOCKET отклоняется с инструкцией миграции на BLUEPRINT_RUNTIME_DESCRIPTOR.

Новый сквозной probe использовал настоящий Codex `0.162.1`, продуктовый `CodexManager`, PTY-сервис и текущий authenticated HTTP runtime. В production preview New/Resume подтвердили один ID `01a12cdb-60c5-74f3-bb5d-b1350ae54e5a`; в перемещённом установленном `.app` — `01a12cdc-460c-75a2-ab58-2fed682d8220`. В обоих случаях backend сообщил Blueprint MCP ready, настоящий `get_blueprint_guide` прошёл через поставляемый bridge и HTTP runtime, а `guide.4` появился в запросе локального Responses-провайдера и выводе TUI. Metadata read вернул сохранённый точный ID; Resume восстановил предыдущий вывод. Параметры approval/sandbox/provider/trust сохранились, launch-only MCP stanza не записалась. Credentials и внешняя модель в этих probes не использовались.

Доказательства: `.tmp/tasks/harness-workspaces-20261011/codex-gate/actual-http-UcdsCY/qualification.json` и `actual-http-CEgIxw/result.json`. Первый результат отдельно сохраняет и сверяет ошибку диагностического host parser: системный Python 3.9 не имел tomllib; те же сохранённые TOML прочитаны установленным Python 3.14. Это не ошибка Codex/Blueprint. Пакет проверен после перемещения в путь с пробелами, без системного Node и без сети упаковки; временные HOME, данные, пакет и принадлежащие probe процессы удалены.

Полные gates текущего снимка фиксируются в `docs/acceptance/CURRENT-STAGE.md`. Исторические Unix/Save результаты ниже не являются доказательством нового HTTP/runtime/TUI UI. Физические клавиатура, IME, focus routing и compositor остаются отдельными видимыми проверками. Поддержка Linux/Windows, VM и дополнительные системные разрешения не заявляются.

## Сохранённое состояние и браузер (2026-10-09)

Новый цикл проверен настоящим stdio MCP-клиентом, подключённым к runtime запущенного Electron. Агент создаёт артефакт с явным `originSession` без привязки проекта; оператор отвечает и аннотирует в UI, нажимает Save; клиент читает снимок через `read_artifact(part="state")` и изображения через `read_attachment`, затем публикует новую версию. До Save интерфейсы MCP не раскрывают приватные ответы, комментарии и изображения.

Отдельные проверки покрывают разные сессии одного проекта, неизменяемость сохранённых состояний, повтор операции, конфликт ожидаемого состояния, восстановление после сбоя, приватную миграцию старых черновиков и сохранение истории утверждений. Electron-проверки покрывают точные текстовые диапазоны и пересечения, переход к старой версии и раскрытие Details, восстановление незавершённого комментария, области документа и браузера, сохранённые нумерованные снимки и отдельные браузерные профили проектов. Цикл выполняется в development, source production и перенесённой unsigned `.app`.

Предыдущий `check:full` от 2026-10-10 также прошёл `codex.spec.ts` с Codex CLI `0.162.1`: модель прочитала поставляемое руководство, создала и опубликовала план; после операторского ответа и Save второй изолированный ход прочитал конкретный saved state и опубликовал новую совместимую версию. Выбранный ответ сохранился. Два ephemeral-хода не являются доставкой в живую сессию или проверкой steer. `tests/e2e/codex.spec.ts` требует модель и авторизацию: локальный `pnpm check` исключает его, обязательный `pnpm check:full` включает без пропуска. Автоматическая доставка, steer, обнаружение живой сессии и MCP Skills не проверены и не включены. Связь `originSession` — метаданные, а не доказательство доступности адресата.

## Доставка instructions установленным Codex

`tests/e2e/instructions.spec.ts` запускает реальный Codex CLI `0.162.1` и настоящий production stdio bridge с пустыми HOME/CODEX_HOME и без credentials. Локальный Responses-провайдер наблюдает в запросе вводную Blueprint, правила приватности, Save и границы полномочий. HTTP остаётся на loopback, внешняя модель не вызывается. Это воспроизводимая проверка попадания инструкции в запрос модели отдельно от MCP handshake; она не доказывает соблюдение правил моделью или поддержку другого клиента.

Матрица текущей приёмки и ограничения физического ввода находятся в `docs/acceptance/CURRENT-STAGE.md`. Камера/микрофон/геолокация проверяются на границе trusted Electron handlers; работоспособность устройств и системные TCC-разрешения не заявлены.

## Историческая граница MCP bridge: Unix transport

Исторический транспорт до текущего изменения: stdio клиент → bridge → локальный Unix socket → runtime. В `tests/bridge.test.ts` реальный процесс bridge подключается к тестовому runtime, принимает handshake MCP `2025-11-25`, возвращает server instructions (текущая вводная ограничена 512 символами), перечисляет инструменты и передаёт вызов. Закрытие stdin завершает bridge и его socket, но тестовый runtime остаётся запущенным. При отсутствующем runtime bridge завершает работу с диагностикой в stderr и пустым stdout. Это проверка транспортной границы, **не** подтверждение работы модели Codex.

Официальная документация SDK v2 описывает поддержку старых клиентов в `serveStdio`; используется явный `legacy: 'serve'`. [MCP SDK: legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html)

Официальная документация Codex описывает stdio MCP и чтение initialization instructions. Наличие инструкции в handshake не доказывает её применение конкретной моделью. [Codex MCP](https://developers.openai.com/codex/mcp/)

| Возможность                         | Статус                        | Что подтверждено / остаётся проверить                                                            |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Bridge stdio и старый MCP handshake | `verified`                    | Изолированный процесс, протокол `2025-11-25`; не клиент Codex                                    |
| Server instructions                 | `verified` на границе bridge  | Handshake и наблюдаемый запрос Codex 0.162.1 к локальному Responses-провайдеру; поведение модели проверяется отдельно                            |
| Обзор и тематическое руководство    | `verified` локально           | Tests guide проверяют темы, версии и offline references                                          |
| MCP через Codex CLI 0.160.1         | `verified` для старого Submit | Изолированная модельная проверка ниже; новый Save-цикл моделью не повторён                       |
| MCP через Codex CLI 0.162.1 | `verified` для Save | Полный видимый gate: guide → публикация → ответ UI → Save → чтение модели → новая версия |
| MCP Skills                          | `not-tested`                  | Alpha расширение не рекламирует; обычные инструменты от него не зависят                          |
| Metadata list/read | `verified` prerequisite 0.162.1 | Настоящий isolated backend/TUI gate; это не история чата и не подключение к чужому CLI |
| Exact New/Resume CLI TUI | `verified` prerequisite 0.162.1 | Новая идентичность/Resume из real protocol; финальный UI/HTTP acceptance отдельно |
| Присутствие чужого CLI | `not-tested` | Metadata/loaded недостаточны; неизвестный внешний статус остаётся unknown |
| Steer активного хода                | `documented`                  | Подтверждено наличие метода и обязательного expectedTurnId; доставка не проверена                |
| Следующий ход простаивающей сессии  | `documented`                  | Метод turn/start существует; разрешение безопасно использовать чужую живую сессию не установлено |
| Сверка неизвестного результата      | `not-tested`                  | Проверить потерянный ответ, чтение истории и корреляцию перед повтором                           |
| Reconnect / закрытая сессия         | `not-tested`                  | Требуется доказать отсутствие автоматического resume или повторного хода                         |

## Историческая packaged-проверка MCP (2026-10-09)

`tests/e2e/packaged.spec.ts` проверяет настоящую unsigned `.app` Electron `44.7.0`, скопированную в другую папку с пробелами с сохранением относительных framework symlinks. Приложение возвращает `app.isPackaged=true` и команду из своего фактического `Contents/Resources/mcp`; тест запускает эту команду с `PATH=/usr/bin:/bin`, недоступным внешним Node и некорректным `NODE_OPTIONS`, который launcher сбрасывает. Bundled Node `24.20.0` обслуживает MCP handshake `2025-11-25`, инструменты и руководство. Документ проходит packaged compiler и отображается в UI; закрытие окна и EOF bridge не завершают runtime, Quit завершает его. Без runtime helper возвращает ошибку и не запускает приложение.

Это проверенная работа packaged транспорта с тестовым MCP-клиентом, а не отдельное испытание packaged команды моделью Codex. Предыдущая Codex CLI `0.160.1` проверка ниже относится к запуску bridge из исходников. Developer ID, notarization и публичная доставка npm не проверены и не реализованы.

Исторический `tests/e2e/disconnection.spec.ts` отдельно проверял асинхронный EPIPE на operator RPC socket Electron main после записи, до ответа: оба уровня Socket/readline обрабатывают ошибку, вызов возвращает `UNKNOWN_RESULT`, необработанного исключения и повторной записи нет. Дополнительный клиент закрывается при ещё стоящих в очереди ответах runtime. Это управляемая проверка транспортного отказа; причина исходного отключения runtime у оператора не установлена.

## Историческая проверка Codex CLI с моделью: цикл Submit

`BLUEPRINT_CODEX_TEST=1 pnpm exec playwright test tests/e2e/codex.spec.ts` выполнен успешно. Electron использовал отдельные app data и временный проект; `codex exec --ephemeral --ignore-user-config` получил MCP-настройки только через `-c`. В тесте явно заданы per-tool `approval_mode="auto"` для девяти локальных Blueprint tools; пользовательский config не записывался. Без этих параметров неинтерактивный CLI отказал в вызовах из-за отсутствия доступного approval.

Модель вызвала обзор и тематические материалы, создала исходник, опубликовала первую версию и показала её. После ответа оператора через настоящий UI и Submit второй изолированный запуск вызвал `read_feedback`, обновил тот же артефакт и показал новую версию. Совместимое выбранное значение сохранилось. Это проверяет применение обычных MCP tools без установки Blueprint skills/hooks. Руководство было явно запрошено в тестовом задании; автоматическую инициативу модели по одной server instruction тест не доказывает.

Синтетическая ручная привязка получателя не доказывает наличие живой CLI-сессии. Два ephemeral-запуска не являются steer в уже открытый ход. Сырые события теста сохраняются локально в `.tmp`; стандартная suite пропускает этот opt-in тест, чтобы не требовать авторизацию и сетевой вызов модели.

Настройка per-tool approvals документирована в [Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Историческое read-only исследование адаптера (2026-10-08)

Выполнены `codex --version`, help для MCP и app-server, а также генерация схем CLI в `.tmp/codex-schema-0.160.1`. В локальных типах имеются `thread/list`, `thread/read`, `thread/loaded/list`, `turn/start`, `turn/steer`. `TurnSteerParams` требует `expectedTurnId` и допускает `clientUserMessageId`; наличие поля не доказывает серверную идемпотентность. `ThreadStatus` содержит `notLoaded`, `idle`, `systemError` и `active`.

`codex app-server daemon version` не подключился к стандартному control socket: он отсутствовал. Это подтверждает отсутствие endpoint по этому пути, а не отсутствие всех процессов или сессий Codex. Новый daemon не запускался. Читать пользовательские истории ради общей проверки не потребовалось.

По документации `thread/read` позволяет читать без resume; `thread/loaded/list` возвращает загруженные thread IDs; `turn/steer` предназначен для активного хода и требует совпадения expectedTurnId. [Codex App Server](https://developers.openai.com/codex/app-server/)

## Отдельная приёмка автоматической доставки

Исследовать только специально созданную тестовую сессию и фиксировать версии клиента, протокола, сервера, macOS и дату. Сначала подтвердить endpoint ownership и связь с реально открытой CLI-сессией. Затем проверить чтение истории, активный steer, сообщение живой простаивающей сессии, закрытую сессию, reconnect и потерю подтверждения после принятия запроса.

Сохранение пакета, принятие транспортом и подтверждённая обработка агентом — разные состояния. При неизвестном результате нельзя автоматически повторять сообщение. Проверить чтение истории и доступную корреляцию; если отсутствие дубля невозможно доказать, доставка остаётся неопределённой. Для закрытого получателя пакет сохраняется без resume.

Автоматическую доставку разрешается включить только после отдельной приёмки этих гарантий. Подключение MCP не устанавливает hooks и не меняет общие правила пользователя. Самостоятельный координатор, автоматическое управление чужим CLI и доставка не входят в Alpha 1. Явный операторский owned Codex launch/Resume и проектные терминалы являются текущим отдельным этапом; они не предоставляют capability внешнего steer.
