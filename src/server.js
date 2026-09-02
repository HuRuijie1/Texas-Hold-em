import { createRealtimeApp } from './realtime-app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const { server } = createRealtimeApp();

server.listen(port, host, () => {
  console.log(`Texas Holdem server running on ${host}:${port}`);
  console.log(`Local: http://localhost:${port}`);
  if (host === '0.0.0.0') {
    console.log('Public: Accessible from all network interfaces');
  }
});
