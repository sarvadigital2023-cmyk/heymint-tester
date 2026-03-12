# HeyMint Solana Contract Tester

## Обзор проекта
Веб-приложение для тестирования Solana-контракта HeyMint на DevNet. Тёмная тема в стиле биржи. Полностраничное, мобильно-адаптивное.

## Технологии
- **Frontend**: React + TypeScript + Vite + Tailwind CSS (тёмная тема)
- **Solana**: @solana/web3.js + @coral-xyz/anchor
- **Графики**: Chart.js
- **UI**: Radix UI + shadcn/ui компоненты
- **Backend**: Express (статика + API)

## Архитектура
- Полностью клиентское приложение — всё взаимодействие с Solana происходит в браузере
- Один главный компонент: `client/src/pages/HeyMintTester.tsx`
- Buffer полифилл в `client/src/main.tsx` для работы @solana/web3.js в браузере

## Ключевые функции
1. **Подключение** к DevNet через RPC + Program ID + IDL JSON
2. **Создание 3 токенов**: LowTest (0.02 SOL), MidTest (1 SOL), HighTest (10 SOL)
3. **15 тестовых кошельков** с airdrop 2 SOL каждому
4. **set_k_buy** перед тестом (K_buy: 40–1000)
5. **Параллельные/последовательные** покупки и продажи
6. **Chart.js** — график buy/sell цен
7. **Пресеты**: Мягкий, Жёсткий, Спам, Арбитраж
8. **Модальные окна** с рекомендациями после каждого этапа
9. **Автоскролл** логов + цветная индикация (зелёный/красный/жёлтый)

## Запуск
```bash
npm run dev
```
Сервер: http://localhost:5000

## Переменные окружения
- `SESSION_SECRET` — секрет сессии Express
