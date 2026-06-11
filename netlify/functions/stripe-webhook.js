/**
 * APEX AI — Stripe Webhook
 * Netlify Function: netlify/functions/stripe-webhook.js
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PRICE_TO_PLAN = {
  'price_1Th1nkRQVLQa72025D8E8hgR': 'plus',
  'price_1Th1o8RQVLQa7202Vo3hteFF': 'premium',
  'price_1Th1oLRQVLQa7202mZp9qTn4': 'elite',
  'price_1Th1qXRQVLQa7202sZTQapGl': 'plus',
  'price_1Th1r0RQVLQa7202qi4SBhIP': 'premium',
  'price_1Th1rSRQVLQa7202FfTj20k5': 'elite',
};

async function setPlan(email, plan) {
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) { console.error('listUsers error:', listErr); return; }
  const user = users.find(u => u.email === email);
  if (!user) { console.warn('No Supabase user found for email:', email); return; }
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, plan, updated_at: new Date().toISOString() });
  if (error) { console.error('Profile update error:', error); }
  else { console.log(`Plan updated: ${email} → ${plan}`); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }
  const data = stripeEvent.data.object;
  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const email = data.customer_details?.email || data.customer_email;
      const priceId = data.line_items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId] || 'plus';
      if (email) await setPlan(email, plan);
      break;
    }
    case 'customer.subscription.updated': {
      const priceId = data.items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId];
      if (plan) {
        const customer = await stripe.customers.retrieve(data.customer);
        if (customer.email) await setPlan(customer.email, plan);
      }
      break;
    }
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
