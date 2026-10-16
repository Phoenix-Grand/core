// English - the language the installer opens in, and the fallback for every
// language whose wizard translation is missing.
export default {
  header: { installation: 'Installation', language: 'Language' },
  nav: {
    welcome: 'Welcome', database: 'Database', admin: 'Administrator',
    instance: 'Instance', install: 'Installation', done: 'Installation complete',
  },
  actions: { next: 'Next', back: 'Back', install: 'Install Kubuno', test: 'Test connection', testing: 'Testing…' },

  welcome: {
    title: "Let's get started",
    lead: 'A few minutes are enough to bring your instance into service.',
    pitchTitle: 'Your cloud, at home',
    pitch: 'Kubuno brings files, calendar, mail and office documents together on your own server. Your data never leaves the machine you administer.',
    tokenLabel: 'Installation token',
    tokenHelp: 'Enter the <1>installation token</1>: it proves you have access to the machine, and stops the first visitor who comes along from claiming the instance. It is written to {{file}} and shown in the service log: {{cmd}}',
  },

  database: {
    title: 'The database',
    lead: 'Kubuno keeps all of its content in PostgreSQL.',
    pitchTitle: 'Nothing goes elsewhere',
    pitch: 'The database stays yours: backups, encryption and hosting follow your rules, not a provider’s.',
    host: 'Host', port: 'Port', name: 'Database', user: 'User', password: 'Password',
    schemaPrefix: 'Schema prefix (optional)',
    schemaPrefixHint: 'Lets several Kubuno instances share one database server, e.g. "kub_". Leave empty for none.',
    connected: 'Connection established',
    createIt: 'Create it during the installation',
    createHint: 'Create it, then run the test again: {{cmd}}',
    alreadyInitialised: 'This database already carries a Kubuno schema. The installation will reuse it without erasing existing data, and will keep the administrator already recorded there.',
  },

  admin: {
    title: 'Your administrator account',
    lead: 'This account administers the instance - it is the most privileged one.',
    pitchTitle: 'You hold the keys',
    pitch: 'No account exists before this one, and nobody else can create it: the password you choose is known to you alone.',
    username: 'Username', email: 'Email address', password: 'Password', confirm: 'Confirmation',
    tooShort: 'At least 12 characters.',
    mismatch: 'The two passwords differ.',
  },

  instance: {
    title: 'Your instance',
    lead: 'The name your users will see.',
    pitchTitle: 'In your image',
    pitch: 'Name, logo, colours and theme are all set afterwards in the administration console, for the whole instance.',
    name: 'Instance name',
    optional: 'optional',
    logo: 'Logo', theme: 'Theme',
    logoDrop: 'Drag an image here, or click to choose one',
    logoChosen: 'Logo chosen',
    logoHint: 'PNG, JPEG, WebP or SVG · 200 KB maximum',
    logoTypes: 'PNG, JPEG, WebP or SVG only.',
    logoTooBig: 'File too heavy - 200 KB maximum.',
    logoUnreadable: 'The file could not be read.',
    remove: 'Remove',
    light: 'light', dark: 'dark',
    footnote: 'Logo and theme are optional - you can change them at any time in the administration console.',
  },

  install: {
    title: 'Ready to install',
    lead: 'Check the summary, then start the installation.',
    pitchTitle: 'No restart',
    pitch: 'The configuration is written, the schema created, then the instance starts by itself on this very port.',
    summaryDb: 'Database', summaryAdmin: 'Administrator', summaryInstance: 'Instance', summaryConfig: 'Configuration',
    toCreate: 'to create',
    working: 'Creating the schema and writing the configuration…',
  },

  done: {
    title: 'Your instance is ready',
    dbReady: 'Database “{{name}}” ready',
    dbReadyText: 'The schema has been created; your data will be kept there.',
    adminCreated: 'Administrator account “{{name}}” created',
    adminCreatedText: 'Sign in with the address and password you have just chosen.',
    adminKept: 'Existing administrator kept',
    adminKeptText: 'This database already held an administrator: it was left in place.',
    configSaved: 'Configuration saved',
    explore: 'Explore {{name}}',
    starting: 'Starting the instance, then redirecting…',
  },

  installed: {
    title: 'Instance already installed',
    text: 'This instance is configured: the installation wizard no longer has a purpose.',
    signIn: 'Go to sign-in',
  },


  // What the server refuses, in the operator's language. It sends a stable code
  // (it cannot know which language this screen is in); these are the sentences.
  footer: {
    poweredBy: 'Powered by <1>{{brand}}</1>',
    license: 'Free software · AGPL-3.0',
  },
  errors: {
    generic: 'Something went wrong.',
    unreachable: 'The server did not answer.',
    'token.invalid': 'Invalid installation token.',
    'db.host_required': 'The database host is required.',
    'db.user_required': 'The database user is required.',
    'db.name_invalid': 'Invalid database name: letters, digits and “_” only, not starting with a digit.',
    'db.bad_password': 'PostgreSQL refused the password for this user.',
    'db.refused': 'Connection refused for this user (see pg_hba.conf).',
    'db.missing': 'This database does not exist.',
    'db.missing_named': 'The database “{{name}}” does not exist yet.',
    'db.timeout': 'Timed out: the host or the port is not answering.',
    'db.other': 'PostgreSQL refused the connection.',
    'db.unreachable': 'Could not connect to the database.',
    'admin.username_short': 'The username must be at least 3 characters.',
    'admin.username_chars': 'The username accepts only letters, digits, “.”, “-” and “_”.',
    'admin.email_invalid': 'Invalid email address.',
    'admin.password_short': 'The administrator password must be at least {{min}} characters.',
    'instance.color_invalid': 'The accent colour must be in #RRGGBB form.',
    'instance.logo_invalid': 'Invalid logo: PNG, JPEG, WebP or SVG data-URI, 200 KB maximum.',
    'install.create_db_failed': 'The database could not be created: {{detail}}',
    'install.schema_failed': 'The schema could not be created: {{detail}}',
    'install.hash_failed': 'The administrator password could not be prepared.',
    'install.admin_failed': 'The administrator account could not be created: {{detail}}',
    'install.config_failed': 'The database is ready but {{path}} could not be written: {{detail}}',
  },

  configNotWritable: '<1>{{path}}</1> cannot be modified by the service: the installation will complete on the database side but will not be able to save the configuration. Give that file to the service user: {{cmd}}',
}
