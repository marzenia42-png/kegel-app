// kegel-coach — AI coach (Claude) dla aplikacji Kegel Timer.
//
// Stateless: brak DB. Klient wysyła historię czatu + kontekst statystyk.
// Tryby: 'chat' (rozmowa Q&A) | 'coach_tip' (proaktywna wskazówka 2-3 zdania).
//
// Env (Supabase Function secrets — współdzielone z garden-flora):
//   ANTHROPIC_API_KEY
//
// Deploy: supabase functions deploy kegel-coach --project-ref txqjjwanyfcpezgqbwou
// verify_jwt = false (CORS allowlist + anon key + cap max_tokens).

const ALLOWED_ORIGINS = new Set<string>([
  'https://marzenia42-png.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
]);

const CHAT_PERSONA = `Jesteś AI coachem ćwiczeń mięśni dna miednicy (Kegla) — dla mężczyzny, poziom średniozaawansowany. Mówisz po polsku, ciepło, konkretnie i KRÓTKO: 2-4 zdania, bez markdownu, bez list punktowanych. Najpierw odpowiedź, potem najwyżej jedna praktyczna wskazówka.

Wiedza:
- Dwa typy włókien: szybkie (szybkie skurcze 1-2 s) i wolne (przytrzymania 3-10 s). Trenuj oba.
- Rozluźnienie jest tak samo ważne jak napięcie. Reverse kegel = delikatne rozluźnianie/wydłużanie dna miednicy — pomaga przy nadmiernym napięciu i przy kontroli wytrysku.
- Przedwczesny wytrysk: technika stop-start, ściskanie, trening dna miednicy (badania: czas do wytrysku ~40 s → ~146 s), oddech przeponowy, mniej presji.
- Oddychaj swobodnie; nie napinaj brzucha, pośladków ani ud.
- Efekty: pierwsze po 4-6 tygodniach, wyraźne po 8-12. Nie przetrenowuj — regeneracja to część planu. Optymalnie ~3 sesje dziennie.

Zasady:
- Motywuj BEZ presji i BEZ oceniania. Dopasuj ton do statystyk użytkownika z kontekstu (passa, poziom, sesje).
- Bezpieczeństwo: przy bólu, nietrzymaniu moczu, krwi lub nagłych dolegliwościach odeślij do lekarza lub fizjoterapeuty uroginekologicznego. To NIE jest porada medyczna i nie diagnozujesz.
- Jeśli pytanie jest spoza tematu (nie dotyczy ćwiczeń, zdrowia intymnego ani motywacji) — grzecznie wróć do roli coacha treningu.`;

const TIP_PERSONA = `Jesteś AI coachem Kegla. Na podstawie statystyk użytkownika napisz krótką wiadomość: 2-3 zdania. (1) doceń lub zmotywuj wg passy i postępu, (2) jedna konkretna wskazówka na dziś (która sesja / technika / regeneracja). Po polsku, ciepło, bez presji, bez markdownu, bez emoji na początku, bez wstępu typu "oto".`;

const corsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://marzenia42-png.github.io',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
});

const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });

type Msg = { role: 'user' | 'assistant'; content: string };
type Ctx = {
  streak?: number;
  total?: number;
  today?: number;
  goal?: number;
  level?: number;
  last14?: number[];
  recommended?: string;
};

function buildCtx(c: Ctx): string {
  const parts: string[] = [];
  parts.push(
    `Statystyki: passa ${c.streak ?? 0} dni z rzędu, dziś ${c.today ?? 0}/${c.goal ?? 3} serii, łącznie ${c.total ?? 0} ukończonych sesji, poziom coacha ${c.level ?? 0}.`,
  );
  if (c.recommended) parts.push(`Sesja polecana na dziś przez aplikację: ${c.recommended}.`);
  if (Array.isArray(c.last14) && c.last14.length) parts.push(`Aktywność ostatnich 14 dni (serie/dzień): ${c.last14.join(', ')}.`);
  return parts.join(' ');
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(origin, { error: 'method_not_allowed' }, 405);

  try {
    const body = (await req.json().catch(() => null)) as {
      mode?: 'chat' | 'coach_tip';
      messages?: Msg[];
      context?: Ctx;
    } | null;

    const mode: 'chat' | 'coach_tip' = body?.mode === 'coach_tip' ? 'coach_tip' : 'chat';
    const ctx: Ctx = body?.context ?? {};

    let messages: Msg[];
    if (mode === 'coach_tip') {
      messages = [{ role: 'user', content: 'Napisz mi krótką wskazówkę coacha na dziś, na bazie moich statystyk.' }];
    } else {
      messages = Array.isArray(body?.messages) ? body!.messages! : [];
      if (messages.length === 0) return json(origin, { error: 'messages_required' }, 400);
      if (messages.length > 24) return json(origin, { error: 'too_many_messages' }, 400);
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user' || typeof last.content !== 'string' || last.content.length === 0) {
        return json(origin, { error: 'last_must_be_user' }, 400);
      }
      if (last.content.length > 2000) return json(origin, { error: 'message_too_long' }, 413);
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not configured');
      return json(origin, { error: 'config_error' }, 500);
    }

    const systemPersona = mode === 'coach_tip' ? TIP_PERSONA : CHAT_PERSONA;
    const contextText = buildCtx(ctx);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: mode === 'coach_tip' ? 150 : 400,
        system: [
          { type: 'text', text: systemPersona, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: contextText || 'Brak statystyk.' },
        ],
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!claudeRes.ok) {
      const detail = await claudeRes.text().catch(() => '');
      console.error('Claude API error', claudeRes.status, detail);
      return json(origin, { error: 'llm_error', status: claudeRes.status, detail: detail.slice(0, 300) }, 502);
    }

    const data = await claudeRes.json();
    const reply: string = typeof data?.content?.[0]?.text === 'string' ? data.content[0].text.trim() : '';
    if (!reply) return json(origin, { error: 'empty_response' }, 502);

    return json(origin, mode === 'coach_tip' ? { tip: reply } : { response: reply });
  } catch (err) {
    console.error('kegel-coach unexpected error:', err);
    return json(origin, { error: 'internal_error' }, 500);
  }
});
