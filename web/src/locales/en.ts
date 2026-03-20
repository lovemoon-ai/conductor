export const en = {
  // Common
  common: {
    title: "Conductor",
    loading: "Loading...",
    backHome: "Back to Home",
    terms: "Terms of Service",
    privacy: "Privacy Policy",
    theme: "Theme",
    themeDark: "Dark",
    themeLight: "Light",
    docs: "Docs",
  },

  // Home page
  home: {
    login: "Login",
    register: "Register",
    enterApp: "Enter App",
    logout: "Logout",
    sloganLine1: "Since work became a chat",
    sloganLine2: "why keep sitting in front of a computer?",
    // Token section
    tokenTitle: "Token",
    tokenHint: "Use this token for cli connections.",
    tokenLoading: "Loading token...",
    tokenCreate: "Create Token",
    tokenCopy: "Copy",
    tokenCopied: "Copied",
    tokenCopyFailed: "Copy failed",
    tokenOverwrite: "Create New",
    tokenLoadFailed: "Unable to load token.",
    tokenCreateFailed: "Unable to create token.",
    authCompleting: "Completing sign-in...",
    authRetrying: "Sign-in is temporarily unavailable. Retrying...",
    authRetryFailed: "We couldn't finish signing in automatically.",
    authRetryAction: "Retry now",
    tokenEmpty: "No token yet.",
    // CLI section
    cliTitle: "CLI Installation",
    cliHint: "Install conductor-cli to get started.",
    cliMacLinux: "macOS, Linux, Windows(WSL2)",
    // Plan section
    planTitle: "Plan",
    planHint: "Free and Plus both have unlimited time access.",
    planStatus: "Status",
    planTier: "Tier",
    planDaysRemaining: "Free Plan Limits",
    planExpiresAt: "Plus Plan Limits",
    planActive: "Active",
    planExpired: "Expired",
    planFreeTrial: "Free",
    planPlus: "Plus",
    planFree: "Free",
    planManage: "Manage",
    insufficientDaysTitle: "Free limit reached",
    insufficientDaysBody:
      "Free allows only 1 fire task, 1 app task, and 1 daemon connection.",
    insufficientDaysCta: "Go to Subscription",
    insufficientDaysClose: "Close",
    inviteTitle: "My Invite Code",
    inviteHint:
      "Share this code. Registration gives +1 day of Plus access, buying Plus gives +7 days of Plus access.",
    inviteCopy: "Copy",
    inviteCopied: "Copied",
    inviteRegisteredCount: "Registered",
    invitePlusCount: "Plus",
    inviteRewards: "Rewards",
    inviteRewardDays: "{days} days",
    inviteRecords: "Invite Records",
    inviteRecordNone: "No invites yet.",
    inviteRecordRegistered: "Registered",
    inviteRecordPlus: "Plus reward",
    inviteLoadFailed: "Failed to load invite data",
  },

  // Login form
  loginForm: {
    title: "Login / Register",
    phone: "Phone Number",
    phonePlaceholder: "Enter phone number",
    emailOrPhone: "Email or Phone",
    placeholder: "you@example.com or +86...",
    inviteCodeLabel: "Invite code?",
    inviteCodePlaceholder: "Enter invite code (optional)",
    myInviteTitle: "My Invite Code",
    myInviteHint:
      "Share this code. Registration gives +1 day of Plus access, buying Plus gives +7 days of Plus access.",
    copyInvite: "Copy",
    copiedInvite: "Copied",
    inviteStats: "Invite Stats",
    inviteRegisteredCount: "Registered",
    invitePlusCount: "Plus",
    inviteRewards: "Rewards",
    inviteRewardDays: "{days} days",
    inviteRecords: "Invite Records",
    inviteRecordNone: "No invites yet.",
    inviteRecordRegistered: "Registered",
    inviteRecordPlus: "Plus reward",
    inviteLoadFailed: "Failed to load invite data",
    sendCode: "Send Code",
    devCode: "Dev code",
    code: "Verification Code",
    codePlaceholder: "Enter verification code",
    submit: "Register / Login",
    consentPrefix: "By signing in or registering, you agree to our ",
    consentAnd: " and ",
    consentSuffix: ", and unregistered phone numbers will be automatically registered.",
    codeSent: "Sent successfully",
    sendFailed: "Send failed",
    networkError: "Network error",
    registered: "Registered",
    loggedIn: "Logged in",
    loginFailed: "Login failed",
  },

  // Subscription page
  subscription: {
    pageTitle: "Subscription Management",
    pageDescription:
      "Free and Plus both support unlimited-time usage. Free allows 1 fire task, 1 app task, and 1 daemon connection. Plus allows 10 each.",
    loadFailed: "Failed to load subscription info",
    // Status section
    currentStatus: "Current Status",
    subscriptionStatus: "Subscription Status",
    subscriptionTier: "Subscription Tier",
    daysRemaining: "Free Limits",
    expiresAt: "Plus Limits",
    days: "days",
    lastPaymentAt: "Last payment:",
    // Status values
    statusFreeTrial: "Free",
    statusActive: "Active",
    statusExpired: "Expired",
    statusCancelled: "Cancelled",
    tierFree: "Free",
    tierPlus: "Plus",
    // Plus section
    plusTitle: "Conductor Plus",
    plusDescription:
      "10 fire tasks, 10 app tasks, 10 daemon connections.",
    priceRMB: "49",
    priceUSD: "7",
    perMonth: "/ month",
    perMonthUSD: "$7 / month",
    // Features
    featuresTitle: "Features Included",
    featureUnlimited: "Unlimited access to all features",
    featurePrioritySupport: "Priority technical support",
    featureFasterResponse: "Faster response times",
    featureMoreStorage: "More storage space",
    featureAdvancedAI: "Advanced AI model access",
    // Trial notice
    trialNotice: "1 fire task, 1 app task, 1 daemon connection.",
    expiredNotice: "10 fire tasks, 10 app tasks, 10 daemon connections.",
    // Buttons
    creatingOrder: "Creating order...",
    alipayRenew: "Alipay Renew",
    alipaySubscribe: "Alipay Subscribe",
    stripeRenew: "Credit Card Renew",
    stripeSubscribe: "Credit Card Subscribe",
    stripeUnsupported: "Credit card payment is not supported yet. Please use Alipay.",
    paymentNote: "Plus takes effect immediately after payment.",
    // Errors
    createPaymentFailed: "Failed to create payment order. Please try again later.",
  },

  // Payment success page
  paymentSuccess: {
    title: "Payment Successful!",
    confirmingStatus: "Confirming subscription status...",
    subscriptionActivated: "Your Conductor Plus subscription has been activated",
    statusPending: "Subscription status is being confirmed, please check later",
    orderId: "Order ID",
    redirectCountdown: "Redirecting to home in {seconds} seconds",
    returnNow: "Return Now",
  },

  // Payment cancel page
  paymentCancel: {
    title: "Payment Cancelled",
    description: "You can return to subscribe anytime",
    orderId: "Order ID",
    redirectCountdown: "Redirecting to home in {seconds} seconds",
    returnNow: "Return Now",
  },

  // Subscription banner
  subscriptionBanner: {
    trialEnded: "Free plan limit reached",
    subscriptionExpired: "Plan update available",
    expiringSoon: "Plan rule reminder",
    subscribeNow: "Free: 1 fire task, 1 app task, 1 daemon connection.",
    renewToContinue: "Plus: 10 fire tasks, 10 app tasks, 10 daemon connections.",
    subscribeButton: "View Plan",
    renewButton: "Upgrade Plus",
  },
};

// Define the structure type (allows any string values)
export interface Translations {
  common: {
    title: string;
    loading: string;
    backHome: string;
    terms: string;
    privacy: string;
    theme: string;
    themeDark: string;
    themeLight: string;
    docs: string;
  };
  home: {
    login: string;
    register: string;
    enterApp: string;
    logout: string;
    sloganLine1: string;
    sloganLine2: string;
    tokenTitle: string;
    tokenHint: string;
    tokenLoading: string;
    tokenCreate: string;
    tokenCopy: string;
    tokenCopied: string;
    tokenCopyFailed: string;
    tokenOverwrite: string;
    tokenLoadFailed: string;
    tokenCreateFailed: string;
    authCompleting: string;
    authRetrying: string;
    authRetryFailed: string;
    authRetryAction: string;
    tokenEmpty: string;
    cliTitle: string;
    cliHint: string;
    cliMacLinux: string;
    planTitle: string;
    planHint: string;
    planStatus: string;
    planTier: string;
    planDaysRemaining: string;
    planExpiresAt: string;
    planActive: string;
    planExpired: string;
    planFreeTrial: string;
    planPlus: string;
    planFree: string;
    planManage: string;
    insufficientDaysTitle: string;
    insufficientDaysBody: string;
    insufficientDaysCta: string;
    insufficientDaysClose: string;
    inviteTitle: string;
    inviteHint: string;
    inviteCopy: string;
    inviteCopied: string;
    inviteRegisteredCount: string;
    invitePlusCount: string;
    inviteRewards: string;
    inviteRewardDays: string;
    inviteRecords: string;
    inviteRecordNone: string;
    inviteRecordRegistered: string;
    inviteRecordPlus: string;
    inviteLoadFailed: string;
  };
  loginForm: {
    title: string;
    phone: string;
    phonePlaceholder: string;
    emailOrPhone: string;
    placeholder: string;
    inviteCodeLabel: string;
    inviteCodePlaceholder: string;
    myInviteTitle: string;
    myInviteHint: string;
    copyInvite: string;
    copiedInvite: string;
    inviteStats: string;
    inviteRegisteredCount: string;
    invitePlusCount: string;
    inviteRewards: string;
    inviteRewardDays: string;
    inviteRecords: string;
    inviteRecordNone: string;
    inviteRecordRegistered: string;
    inviteRecordPlus: string;
    inviteLoadFailed: string;
    sendCode: string;
    devCode: string;
    code: string;
    codePlaceholder: string;
    submit: string;
    consentPrefix: string;
    consentAnd: string;
    consentSuffix: string;
    codeSent: string;
    sendFailed: string;
    networkError: string;
    registered: string;
    loggedIn: string;
    loginFailed: string;
  };
  subscription: {
    pageTitle: string;
    pageDescription: string;
    loadFailed: string;
    currentStatus: string;
    subscriptionStatus: string;
    subscriptionTier: string;
    daysRemaining: string;
    expiresAt: string;
    days: string;
    lastPaymentAt: string;
    statusFreeTrial: string;
    statusActive: string;
    statusExpired: string;
    statusCancelled: string;
    tierFree: string;
    tierPlus: string;
    plusTitle: string;
    plusDescription: string;
    priceRMB: string;
    priceUSD: string;
    perMonth: string;
    perMonthUSD: string;
    featuresTitle: string;
    featureUnlimited: string;
    featurePrioritySupport: string;
    featureFasterResponse: string;
    featureMoreStorage: string;
    featureAdvancedAI: string;
    trialNotice: string;
    expiredNotice: string;
    creatingOrder: string;
    alipayRenew: string;
    alipaySubscribe: string;
    stripeRenew: string;
    stripeSubscribe: string;
    stripeUnsupported: string;
    paymentNote: string;
    createPaymentFailed: string;
  };
  paymentSuccess: {
    title: string;
    confirmingStatus: string;
    subscriptionActivated: string;
    statusPending: string;
    orderId: string;
    redirectCountdown: string;
    returnNow: string;
  };
  paymentCancel: {
    title: string;
    description: string;
    orderId: string;
    redirectCountdown: string;
    returnNow: string;
  };
  subscriptionBanner: {
    trialEnded: string;
    subscriptionExpired: string;
    expiringSoon: string;
    subscribeNow: string;
    renewToContinue: string;
    subscribeButton: string;
    renewButton: string;
  };
}
