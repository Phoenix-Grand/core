// Français.
export default {
  header: { installation: 'Installation', language: 'Langue' },
  nav: {
    welcome: 'Bienvenue', database: 'Base de données', admin: 'Administrateur',
    instance: 'Instance', install: 'Installation', done: 'Installation terminée',
  },
  actions: { next: 'Suivant', back: 'Retour', install: 'Installer Kubuno', test: 'Tester la connexion', testing: 'Test en cours…' },

  welcome: {
    title: 'Commençons',
    lead: 'Quelques minutes suffisent pour mettre votre instance en service.',
    pitchTitle: 'Votre cloud, chez vous',
    pitch: 'Kubuno réunit fichiers, agenda, courrier et bureautique sur votre propre serveur. Vos données ne quittent pas la machine que vous administrez.',
    tokenLabel: "Jeton d'installation",
    tokenHelp: "Saisissez le <1>jeton d'installation</1> : il prouve que vous avez accès à la machine, et évite que le premier visiteur venu s'approprie l'instance. Il se trouve dans {{file}} et dans le journal du service : {{cmd}}",
  },

  database: {
    title: 'La base de données',
    lead: 'Kubuno conserve tout son contenu dans PostgreSQL.',
    pitchTitle: 'Rien ne part ailleurs',
    pitch: "La base reste la vôtre : sauvegardes, chiffrement et hébergement suivent vos règles, pas celles d'un prestataire.",
    host: 'Hôte', port: 'Port', name: 'Base de données', user: 'Utilisateur', password: 'Mot de passe',
    schemaPrefix: 'Préfixe de schéma (optionnel)',
    schemaPrefixHint: 'Permet à plusieurs instances Kubuno de cohabiter sur un même serveur, ex. « kub_ ». Laissez vide pour aucun.',
    connected: 'Connexion établie',
    createIt: "La créer pendant l'installation",
    createHint: 'Créez-la puis relancez le test : {{cmd}}',
    alreadyInitialised: "Cette base contient déjà un schéma Kubuno. L'installation la réutilisera sans effacer les données existantes, et conservera l'administrateur déjà en place.",
  },

  admin: {
    title: 'Votre compte administrateur',
    lead: "Ce compte administre l'instance - c'est le plus privilégié.",
    pitchTitle: 'Vous détenez les clés',
    pitch: "Aucun compte n'existe avant celui-ci, et personne d'autre ne peut le créer : le mot de passe que vous choisissez n'est connu que de vous.",
    username: "Nom d'utilisateur", email: 'Adresse e-mail', password: 'Mot de passe', confirm: 'Confirmation',
    tooShort: 'Au moins 12 caractères.',
    mismatch: 'Les deux mots de passe diffèrent.',
  },

  instance: {
    title: 'Votre instance',
    lead: 'Le nom que verront vos utilisateurs.',
    pitchTitle: 'À votre image',
    pitch: "Nom, logo, couleurs et thème se règlent ensuite dans la console d'administration, pour toute l'instance.",
    name: "Nom de l'instance",
    optional: 'facultatif',
    logo: 'Logo', theme: 'Thème',
    logoDrop: 'Glissez une image ici, ou cliquez pour la choisir',
    logoChosen: 'Logo choisi',
    logoHint: 'PNG, JPEG, WebP ou SVG · 200 Ko maximum',
    logoTypes: 'PNG, JPEG, WebP ou SVG uniquement.',
    logoTooBig: 'Fichier trop lourd - 200 Ko maximum.',
    logoUnreadable: 'Lecture du fichier impossible.',
    remove: 'Retirer',
    light: 'clair', dark: 'sombre',
    footnote: "Logo et thème sont facultatifs - vous les changerez à tout moment dans la console d'administration.",
  },

  install: {
    title: 'Prêt à installer',
    lead: "Vérifiez, puis lancez l'installation.",
    pitchTitle: 'Aucun redémarrage',
    pitch: "La configuration est écrite, le schéma créé, puis l'instance démarre d'elle-même sur ce même port.",
    summaryDb: 'Base de données', summaryAdmin: 'Administrateur', summaryInstance: 'Instance', summaryConfig: 'Configuration',
    toCreate: 'à créer',
    working: 'Création du schéma et écriture de la configuration…',
  },

  done: {
    title: 'Votre instance est prête',
    dbReady: 'Base de données « {{name}} » prête',
    dbReadyText: 'Le schéma a été créé ; vos données y seront conservées.',
    adminCreated: 'Compte administrateur « {{name}} » créé',
    adminCreatedText: "Connectez-vous avec l'adresse et le mot de passe que vous venez de choisir.",
    adminKept: 'Administrateur existant conservé',
    adminKeptText: "Cette base contenait déjà un administrateur : il a été laissé en place.",
    configSaved: 'Configuration enregistrée',
    explore: 'Découvrir {{name}}',
    starting: "Démarrage de l'instance, puis redirection…",
  },

  installed: {
    title: 'Instance déjà installée',
    text: "Cette instance est configurée : l'assistant d'installation n'a plus lieu d'être.",
    signIn: 'Aller à la connexion',
  },


  // Ce que le serveur refuse, dans la langue de l'exploitant. Il envoie un code
  // stable (il ignore la langue de cet écran) ; voici les phrases.
  footer: {
    poweredBy: 'Propulsé par <1>{{brand}}</1>',
    license: 'Logiciel libre · AGPL-3.0',
  },
  errors: {
    generic: 'Une erreur est survenue.',
    unreachable: "Le serveur n'a pas répondu.",
    'token.invalid': "Jeton d'installation invalide.",
    'db.host_required': "L'hôte de la base est requis.",
    'db.user_required': "L'utilisateur de la base est requis.",
    'db.name_invalid': 'Nom de base invalide : lettres, chiffres et « _ » uniquement, sans chiffre en première position.',
    'db.bad_password': 'Mot de passe refusé par PostgreSQL pour cet utilisateur.',
    'db.refused': 'Connexion refusée pour cet utilisateur (voir pg_hba.conf).',
    'db.missing': "Cette base n'existe pas.",
    'db.missing_named': "La base « {{name}} » n'existe pas encore.",
    'db.timeout': "Délai dépassé : l'hôte ou le port ne répond pas.",
    'db.other': 'PostgreSQL a refusé la connexion.',
    'db.unreachable': 'Connexion à la base impossible.',
    'admin.username_short': "Le nom d'utilisateur doit faire au moins 3 caractères.",
    'admin.username_chars': "Le nom d'utilisateur n'accepte que lettres, chiffres, « . », « - » et « _ ».",
    'admin.email_invalid': 'Adresse e-mail invalide.',
    'admin.password_short': 'Le mot de passe administrateur doit faire au moins {{min}} caractères.',
    'instance.color_invalid': "La couleur d'accent doit être au format #RRGGBB.",
    'instance.logo_invalid': 'Logo invalide : PNG, JPEG, WebP ou SVG en data-URI, 200 Ko maximum.',
    'install.create_db_failed': 'Création de la base impossible : {{detail}}',
    'install.schema_failed': 'Création du schéma impossible : {{detail}}',
    'install.hash_failed': "Impossible de préparer le mot de passe administrateur.",
    'install.admin_failed': 'Création du compte administrateur impossible : {{detail}}',
    'install.config_failed': "La base est prête mais {{path}} n'a pas pu être écrit : {{detail}}",
  },

  configNotWritable: "<1>{{path}}</1> n'est pas modifiable par le service : l'installation ira au bout côté base de données mais ne pourra pas enregistrer la configuration. Donnez ce fichier à l'utilisateur du service : {{cmd}}",
}
