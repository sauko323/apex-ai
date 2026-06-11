// APEX AI — Auth Guard
// Included at the top of apex-ai.html — redirects to login if not signed in
(function() {
  const SUPABASE_URL = 'https://aidagxmynqzrbkyagvcz.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpZGFneG15bnF6cmJreWFndmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjk2MjgsImV4cCI6MjA5NjcwNTYyOH0.og_8Lztn5GhonZwwMM5ZK0oCbdgW5hRw9cNqfDuiVYE';

  // Wait for supabase-js to load then check session
  function checkAuth() {
    if (!window.supabase) {
      setTimeout(checkAuth, 50);
      return;
    }
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Expose client globally so other scripts can use it
    window.APEX_SUPABASE = client;

    client.auth.getSession().then(({ data }) => {
      if (!data.session) {
        window.location.href = 'apex-auth.html';
        return;
      }
      // Store user info globally
      window.APEX_USER = data.session.user;

      // Listen for sign-out
      client.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') {
          window.location.href = 'apex-auth.html';
        }
      });

      // Set user display in sidebar if element exists
      const nameEl = document.getElementById('driverName');
      const emailEl = document.getElementById('driverEmail');
      if (nameEl) nameEl.textContent = data.session.user.user_metadata?.full_name || data.session.user.email.split('@')[0];
      if (emailEl) emailEl.textContent = data.session.user.email;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
  } else {
    checkAuth();
  }
})();
