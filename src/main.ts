import { ServerOptions, cli, defineAgent, inference, log, metrics, voice } from '@livekit/agents';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_MODE, createAgent } from './agent.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env' });

export default defineAgent({
  entry: async (ctx) => {
    // Printed once per job so `bench/preflight.sh` can confirm a benchmark run is actually
    // running the stripped-down build, not the production one, before ramping load against it.
    log().info({ benchmarkMode: BENCHMARK_MODE }, 'survey-agent starting');

    // Set up a voice AI pipeline using Sarvam STT/TTS and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // Uses the Sarvam plugin directly with your own SARVAM_API_KEY, rather than LiveKit Inference
      stt: new sarvam.STT({
        model: 'saaras:v3',
        languageCode: 'hi-IN', // auto-detect the language the user is speaking
        mode: 'transcribe',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // Uses the Sarvam plugin directly with your own SARVAM_API_KEY, rather than LiveKit Inference
      tts: new sarvam.TTS({
        model: 'bulbul:v3',
        speaker: 'simran',
        targetLanguageCode: 'hi-IN', // replies are always spoken in Hindi; TTS has no auto-detect
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        endpointing: {
          // Raised from the 500ms default to give Sarvam STT (slower over 8kHz phone audio)
          // more time to deliver its final transcript before the turn is committed. Without
          // this, late transcripts arrive after the turn already closed, invalidating an
          // in-progress response and causing an audible cutoff/restart.
          minDelay: 900,
        },
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode is disabled: it requires a LiveKit Inference TTS model that declares a
      // markup dialect (e.g. Fish Audio, Inworld, Cartesia, xAI), which Sarvam does not.
      expressive: false,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    // Note: no noiseCancellation is configured. Enhanced NC providers (ai-coustics, Krisp)
    // require either LiveKit Cloud or your own provider license key for self-hosted use,
    // and WebRTC's built-in NC is client-side only (doesn't cover SIP/telephony audio).
    await session.start({
      agent: createAgent(),
      room: ctx.room,
    });

    // Log per-turn latency and usage metrics (LLM TTFT, TTS TTFB, end-to-end) to the same logger
    // used for all other agent logs.
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    // Hard cap on call duration: ends the call after 15 minutes regardless of what's being said,
    // as a safety net alongside the prompt-level guardrail that asks Avni to end early on misuse.
    // deleteRoom (not session.close) is required to actually hang up the SIP caller, matching the
    // end-call tool below - otherwise the caller's phone line stays connected in an empty room.
    // Disabled in benchmark mode: a load-test room has no real caller to protect and the timer
    // would otherwise cut every step short past the 15-minute mark.
    if (!BENCHMARK_MODE) {
      const HARD_CALL_LIMIT_MS = 15 * 60 * 1000;
      const hardLimitTimer = setTimeout(async () => {
        await session.say('Samay ho gaya hai, main call yahin samaapt karti hoon. Dhanyavaad.');
        await ctx.deleteRoom();
      }, HARD_CALL_LIMIT_MS);
      ctx.addShutdownCallback(async () => clearTimeout(hardLimitTimer));
    }

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'survey-agent',
  }),
);
