# Network modules

В этой папке собраны файлы, связанные с сетевыми настройками и работой прокси:

- `config.js` — env-конфиг прокси/гео/эскалации
- `proxyClient.js` — клиент MobileProxy SDK и rate-limit
- `escalator.js` — логика эскалации `changeIp -> changeOperator -> changeGeo`
- `loadEnv.js` — автозагрузка `.env`
