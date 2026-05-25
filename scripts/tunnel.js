require("dotenv").config();

const ngrok = require("@ngrok/ngrok");

const port = Number(process.env.PORT) || 3000;

(async () => {
  try {
    const listener = await ngrok.forward({
      addr: port,
      authtoken_from_env: true,
    });
    const url = listener.url();
    console.log(`\nTunnel פעיל: ${url}`);
    console.log(`Webhook לדוגמה: ${url}/webhook\n`);

    const shutdown = async () => {
      try {
        await listener.close();
      } catch (_) {
        /* ignore */
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Keep the Node process alive while the ngrok listener is open.
    setInterval(() => {}, 1 << 30);
  } catch (err) {
    console.error(err.message || err);
    if (!process.env.NGROK_AUTHTOKEN) {
      console.error(
        "\nהוסף NGROK_AUTHTOKEN ל-.env (מ-dashboard.ngrok.com → Your Authtoken)\n"
      );
    }
    process.exit(1);
  }
})();
