import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: !!process.env.AUTH_TRUST_HOST || process.env.FLOWBLOCK_LOCAL_MODE === '1',
  providers: process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? [Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })] : [],
  session: { strategy: 'jwt' },
  callbacks: {
    signIn({ profile }) { return profile?.email_verified === true; },
    jwt({ token, account }) { if (account) token.sub = `${account.provider}:${account.providerAccountId}`; return token; },
    session({ session, token }) { if (session.user) session.user.id = token.sub!; return session; },
  },
});
