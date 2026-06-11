/**
 * APEX AI — Stripe Webhook
 * Netlify Function: netlify/functions/stripe-webhook.js
 *
 * When a user subscribes or cancels, this automatically updates
 * their plan in Supabase so the app gates features correctly.
 *
 * SETUP STEPS (do once):
 * 1. Go to Netlify → Site → Environment Variables, add:
 *    STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → your endpoint → Signing secret
 *    STRIPE_SECRET_KEY      — from Stripe Dashboard → Developers → API keys → Secret key
 *    SUPABASE_URL           — https://aidagxmynqzrbkyagvcz.supabase.co
 *    SUPABASE_SERVICE_KEY   — from Supabase → Settings → API → service_role key (NOT publishable)
 *
 * 2. Go to Stripe Dashboard → Developers → Webhooks → Add endpoint
 *    URL: https://apex-sim-ai.netlify.app/.netlify/functions/stripe-webhook
 *    Events to listen for:
 *      checkout.session.completed
 *      customer.subscription.updated
 *      customer.subscription.deleted
 *
 * 3. Upload this file to your GitHub repo at:
 *    netlify/functions/stripe-webhook.js
 *
 * 4. Upload netlify.toml (also in your files) to repo root.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key bypasses RLS so we can update any user
);

// Map Stripe Price IDs → APEX plan names
// Replace these with your actual Stripe Price IDs from your dashboard
const PRICE_TO_PLAN = {
  // Monthly
  'price_plus_monthly':    'plus',
  'price_premium_monthly': 'premium',
  'price_elite_monthly':   'elite',
  // Yearly
  'price_plus_yearly':     'plus',
  'price_premium_yearly':  'premium',
  'price_elite_yearly':    'elite',
};

async function setPlan(email, plan) {
  // Find user by email in Supabase auth
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) { console.error('listUsers error:', listErr); return; }

  const user = users.find(u => u.email === email);
  if (!user) { console.warn('No Supabase user found for email:', email); return; }

  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, plan, updated_at: new Date().toISOString() });

  if (error) {
    console.error('Profile update error:', error);
  } else {
    console.log(`Plan updated: ${email} → ${plan}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const data = stripeEvent.data.object;

  switch (stripeEvent.type) {

    // User just completed checkout (new subscription)
    case 'checkout.session.completed': {
      const email = data.customer_details?.email || data.customer_email;
      const priceId = data.line_items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId] || 'plus';
      if (email) await setPlan(email, plan);
      break;
    }

    // Subscription changed (upgrade, downgrade, renewal)
    case 'customer.subscription.updated': {
      const priceId = data.items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId];
      if (plan) {
        // Get email from Stripe customer
        const customer = await stripe.customers.retrieve(data.customer);
        if (customer.email) await setPlan(customer.email, plan);
      }
      break;
    }

    // Subscription cancelled — revert to free
    case 'customer.subscription.deleted': {
      const customer = await stripe.customers.retrieve(data.customer);
      if (customer.email) await setPlan(customer.email, 'free');
      break;
    }

    default:
      console.log('Unhandled event type:', stripeEvent.type);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
