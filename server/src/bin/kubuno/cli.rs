//! Définition de la ligne de commande (clap).

use clap::{Arg, ArgAction, Command};

pub fn cli() -> Command {
    Command::new("kubuno")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Console d'administration Kubuno")
        .long_about(
            "kubuno — console d'administration de la plateforme Kubuno.\n\
             \n\
             COMMANDES CORE\n\
             \n\
             db:backup          Sauvegarde la base de données PostgreSQL\n\
             db:restore         Restaure depuis une sauvegarde\n\
             db:reset           Réinitialise le schéma core (toutes les données supprimées)\n\
             db:migrate         Applique les migrations SQL en attente\n\
             db:status          Affiche la connectivité et les migrations\n\
             app:reset          Remet toute l'application à zéro\n\
             auth:recover       Rétablit l'accès d'un compte (second facteur perdu)\n\
             security:rekey     Renouvelle la clé de chiffrement des données\n\
             status             Affiche l'état du serveur et des modules\n\
             modules:commands   Liste les commandes CLI des modules installés\n\
             \n\
             COMMANDES MODULES (exemples)\n\
             \n\
             assistant:models      Lister les modèles LLM disponibles\n\
             assistant:providers   Afficher les fournisseurs LLM configurés\n\
             assistant:agents      Lister les agents de l'assistant\n\
             files:quota        Afficher les quotas de stockage\n\
             \n\
             Toute commande de la forme <module>:<cmd> est routée vers le binaire\n\
             kubuno-<module>. Utilisez `kubuno modules:commands` pour voir toutes\n\
             les commandes disponibles selon les modules installés.\n\
             \n\
             CONFIGURATION\n\
             \n\
             Les commandes agissent sur l'instance système (configuration\n\
             /etc/kubuno/config.toml, %ProgramData%\\Kubuno\\config.toml ou\n\
             /Library/Application Support/Kubuno/config.toml) seulement lancées en\n\
             root / Administrateur (sudo kubuno …) ou par le compte de service.\n\
             Pour une autre instance : KV_CONFIG_FILE=<fichier> kubuno …",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(
            Command::new("marketplace:metadata")
                .about("Export optional module Marketplace text, or merge it into catalog JSON")
                .arg(Arg::new("manifest").required(true).value_name("MODULE_TOML"))
                .arg(Arg::new("catalog").long("catalog").value_name("CATALOG_JSON")
                    .help("Preserve all catalog fields and update text only for the matching ID/version")),
        )
        // ── security:rekey ──
        .subcommand(
            Command::new("security:rekey")
                .about("Renouvelle la clé de chiffrement des données")
                .long_about(
                    "Tire une nouvelle clé de chiffrement des données et re-chiffre tout ce\n\
                     qu'elle protège : mot de passe SMTP, mot de passe de liaison de l'annuaire,\n\
                     secrets clients OpenID Connect, secrets de double authentification,\n\
                     identifiants des campagnes de migration.\n\
                     \n\
                     Cette clé vit dans son propre fichier (/var/lib/kubuno/data.key) et est\n\
                     amorcée, au premier démarrage, avec le secret JWT alors en vigueur. Si ce\n\
                     secret était faible, partagé ou resté à la valeur d'exemple, la clé de\n\
                     données l'est aussi : cette commande est le seul moyen de la renouveler.\n\
                     \n\
                     Arrêtez le service et sauvegardez la base ET le fichier de clé avant de\n\
                     lancer l'opération. Tout est écrit dans une seule transaction, et la\n\
                     nouvelle clé n'est posée qu'une fois celle-ci validée.",
                )
                .arg(
                    Arg::new("force")
                        .long("force")
                        .action(ArgAction::SetTrue)
                        .help("Ne pas demander de confirmation"),
                )
                .arg(
                    Arg::new("check")
                        .long("check")
                        .action(ArgAction::SetTrue)
                        .help("Vérifier seulement que tout est lisible, sans rien écrire"),
                )
                .arg(
                    Arg::new("config")
                        .long("config")
                        .value_name("FICHIER")
                        .help("Configuration de l'instance (défaut : le fichier système /etc/kubuno/config.toml, lu seulement sous sudo, par le compte de service ou par le service)"),
                ),
        )
        // ── db:backup ──
        .subcommand(
            Command::new("db:backup")
                .about("Sauvegarde la base de données PostgreSQL")
                .long_about(
                    "Exporte le schéma core en SQL clair via pg_dump.\n\
                     Nécessite que postgresql-client soit installé.",
                )
                .arg(
                    Arg::new("output")
                        .short('o')
                        .long("output")
                        .value_name("FICHIER")
                        .help("Fichier de sortie (défaut : kubuno_backup_YYYYMMDD_HHMMSS.sql)"),
                )
                .arg(
                    Arg::new("full")
                        .long("full")
                        .action(ArgAction::SetTrue)
                        .help("Sauvegarder toute la base (pas seulement le schéma core)"),
                ),
        )
        // ── db:restore ──
        .subcommand(
            Command::new("db:restore")
                .about("Restaure la base de données depuis une sauvegarde")
                .long_about(
                    "Importe un fichier SQL produit par db:backup via psql.\n\
                     Nécessite que postgresql-client soit installé.",
                )
                .arg(
                    Arg::new("file")
                        .required(true)
                        .value_name("FICHIER")
                        .help("Fichier de sauvegarde à restaurer (.sql)"),
                )
                .arg(
                    Arg::new("force")
                        .long("force")
                        .action(ArgAction::SetTrue)
                        .help("Ne pas demander de confirmation"),
                ),
        )
        // ── db:reset ──
        .subcommand(
            Command::new("db:reset")
                .about("Réinitialise la base de données (supprime et recrée le schéma core)")
                .long_about(
                    "Supprime le schéma core en CASCADE puis applique toutes\n\
                     les migrations depuis zéro. TOUTES LES DONNÉES SONT PERDUES.",
                )
                .arg(
                    Arg::new("force")
                        .long("force")
                        .action(ArgAction::SetTrue)
                        .help("Ne pas demander de confirmation (dangereux)"),
                ),
        )
        // ── db:migrate ──
        .subcommand(
            Command::new("db:migrate")
                .about("Applique les migrations SQL en attente"),
        )
        // ── db:status ──
        .subcommand(
            Command::new("db:status")
                .about("Affiche la connectivité et l'état des migrations"),
        )
        // ── app:reset ──
        .subcommand(
            Command::new("app:reset")
                .about("Remet TOUTE l'application à zéro")
                .long_about(
                    "Supprime TOUTES les données : schémas DB (core + tous les modules),\n\
                     historique de migrations et fichiers de stockage.\n\
                     Recrée ensuite le schéma core, les paramètres par défaut et le\n\
                     compte administrateur initial.\n\n\
                     Les modules relanceront automatiquement leurs propres migrations\n\
                     au prochain démarrage.\n\n\
                     CETTE OPÉRATION EST IRRÉVERSIBLE.",
                )
                .arg(
                    Arg::new("force")
                        .long("force")
                        .action(ArgAction::SetTrue)
                        .help("Ne pas demander de confirmation (dangereux)"),
                )
                .arg(
                    Arg::new("keep-files")
                        .long("keep-files")
                        .action(ArgAction::SetTrue)
                        .help("Conserver les fichiers de stockage (ne supprime que la DB)"),
                ),
        )
        // ── auth:recover ──
        // Voie de secours locale : jamais exposée par HTTP (cf. bin/kubuno/auth.rs).
        .subcommand(
            Command::new("auth:recover")
                .about("Rétablit l'accès d'un compte (second facteur perdu, authentification locale fermée)")
                .long_about(
                    "Rétablit l'accès d'un compte depuis la machine elle-même, lorsque le\n\
                     second facteur est perdu et qu'aucune voie web ne reste ouverte.\n\
                     \n\
                     L'accès physique (ou shell) à la machine vaut confiance racine : qui\n\
                     peut lancer cette commande peut déjà lire les identifiants de la base.\n\
                     Cette voie n'est JAMAIS exposée par HTTP.\n\
                     \n\
                     Sans option, la double authentification est désactivée (et les sessions\n\
                     révoquées). Chaque exécution écrit une entrée d'audit d'origine « système ».\n\
                     \n\
                     --local-access rouvre le mot de passe LOCAL pour ce compte, quelle que soit\n\
                     la politique de son unité organisationnelle et même si un niveau supérieur\n\
                     l'a verrouillée : la ligne est écrite à la portée « compte », la plus\n\
                     spécifique. C'est la voie de secours quand l'authentification locale a été\n\
                     désactivée et que l'annuaire est injoignable. --set-password l'accompagne\n\
                     lorsque le compte n'a plus de mot de passe local du tout.",
                )
                .arg(
                    Arg::new("account")
                        .required(true)
                        .value_name("EMAIL|UTILISATEUR")
                        .help("Compte à rétablir"),
                )
                .arg(
                    Arg::new("disable-2fa")
                        .long("disable-2fa")
                        .action(ArgAction::SetTrue)
                        .help("Désactiver la double authentification et supprimer les codes de secours"),
                )
                .arg(
                    Arg::new("backup-codes")
                        .long("backup-codes")
                        .action(ArgAction::SetTrue)
                        .help("Générer un nouveau lot de codes de secours (affiché une seule fois)"),
                )
                .arg(
                    Arg::new("grace-days")
                        .long("grace-days")
                        .value_name("JOURS")
                        .help("Reporter le délai de grâce « 2FA obligatoire » de N jours"),
                )
                .arg(
                    Arg::new("local-access")
                        .long("local-access")
                        .action(ArgAction::SetTrue)
                        .help("Rouvrir le mot de passe local pour ce compte (portée « compte », ignore les verrous)"),
                )
                .arg(
                    Arg::new("set-password")
                        .long("set-password")
                        .action(ArgAction::SetTrue)
                        .help("Définir un nouveau mot de passe local (saisi au clavier)"),
                )
                .arg(
                    Arg::new("force")
                        .long("force")
                        .action(ArgAction::SetTrue)
                        .help("Ne pas demander de confirmation"),
                ),
        )
        // ── status ──
        .subcommand(
            Command::new("status")
                .about("Affiche l'état du serveur Kubuno"),
        )
        // ── modules:commands ──
        .subcommand(
            Command::new("modules:commands")
                .about("Liste les commandes CLI offertes par les modules installés"),
        )
        // ── modules:install ──
        .subcommand(
            Command::new("modules:install")
                .about("Installe un module depuis un paquet .kbpkg local")
                .long_about(
                    "Installe un module depuis un fichier .kbpkg LOCAL — le SEUL format\n\
                     d'empaquetage d'un module (le format multiplateforme de Kubuno : une\n\
                     archive ZIP portant le répertoire du module à sa racine). Les paquets\n\
                     système (.deb, .rpm, .tar.gz) sont refusés.\n\
                     \n\
                     L'archive est extraite, ses empreintes SHA256SUMS vérifiées si présentes,\n\
                     puis le module est déposé dans le store inscriptible du core\n\
                     (/var/lib/kubuno/modules-store/<id>). L'id est lu dans module.toml, jamais\n\
                     dans le nom de fichier. Le core démarre le module au prochain lancement :\n\
                     redémarrez le service (systemctl restart kubuno) pour l'activer à chaud.\n\
                     \n\
                     Aucune connexion réseau ni catalogue n'est requis — c'est l'installation\n\
                     hors-ligne, à partir d'un fichier déjà téléchargé ou construit localement\n\
                     par build_kbpkg.sh.",
                )
                .arg(
                    Arg::new("file")
                        .required(true)
                        .value_name("FICHIER.kbpkg")
                        .help("Chemin du paquet .kbpkg à installer"),
                ),
        )
        // ── modules:list ──
        .subcommand(
            Command::new("modules:list")
                .about("Liste les modules installés dans le store (installables/désinstallables)"),
        )
        // Les commandes des modules (ex: files:upload, photos:sync…) sont routées
        // dynamiquement vers le binaire kubuno-<module>. Voir allow_external_subcommands.
        .allow_external_subcommands(true)
}

/// Récupère les arguments bruts d'une sous-commande externe (`allow_external_subcommands`).
pub fn external_args(sub: &clap::ArgMatches) -> Vec<String> {
    sub.get_many::<std::ffi::OsString>("")
        .into_iter()
        .flatten()
        .map(|s| s.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_subcommands_exist() {
        let app = cli();
        let subcmds: Vec<&str> = app.get_subcommands().map(|c| c.get_name()).collect();
        assert!(subcmds.contains(&"db:backup"));
        assert!(subcmds.contains(&"db:restore"));
        assert!(subcmds.contains(&"db:reset"));
        assert!(subcmds.contains(&"db:migrate"));
        assert!(subcmds.contains(&"db:status"));
        assert!(subcmds.contains(&"app:reset"));
        assert!(subcmds.contains(&"status"));
    }

    #[test]
    fn test_cli_app_reset_flags() {
        let m = cli()
            .try_get_matches_from(["kubuno", "app:reset", "--force", "--keep-files"])
            .unwrap();
        let sub = m.subcommand_matches("app:reset").unwrap();
        assert!(sub.get_flag("force"));
        assert!(sub.get_flag("keep-files"));
    }

    #[test]
    fn test_cli_app_reset_no_flags() {
        // La commande doit être valide sans arguments
        assert!(cli()
            .try_get_matches_from(["kubuno", "app:reset"])
            .is_ok());
    }

    #[test]
    fn test_cli_db_backup_output_arg() {
        let m = cli()
            .try_get_matches_from(["kubuno", "db:backup", "-o", "/tmp/test.sql"])
            .unwrap();
        let sub = m.subcommand_matches("db:backup").unwrap();
        assert_eq!(sub.get_one::<String>("output").unwrap(), "/tmp/test.sql");
    }

    #[test]
    fn test_cli_db_restore_requires_file() {
        // Sans fichier → erreur
        assert!(cli()
            .try_get_matches_from(["kubuno", "db:restore"])
            .is_err());
    }

    #[test]
    fn test_cli_db_reset_force_flag() {
        let m = cli()
            .try_get_matches_from(["kubuno", "db:reset", "--force"])
            .unwrap();
        let sub = m.subcommand_matches("db:reset").unwrap();
        assert!(sub.get_flag("force"));
    }

    #[test]
    fn test_cli_module_reset_captured_as_external() {
        // files:reset doit être capturé comme sous-commande externe (allow_external_subcommands)
        let m = cli()
            .try_get_matches_from(["kubuno", "files:reset", "--force"])
            .unwrap();
        let (name, sub) = m.subcommand().unwrap();
        assert_eq!(name, "files:reset");
        assert!(external_args(sub).contains(&"--force".to_string()));
    }

    #[test]
    fn test_cli_external_subcommand_dispatch() {
        // Vérifie que files:upload + ses args sont capturés en OsString sans panic
        let m = cli()
            .try_get_matches_from(["kubuno", "files:upload", "mon_fichier.pdf", "--token", "kubuno_xxx"])
            .unwrap();
        let (name, sub) = m.subcommand().unwrap();
        assert_eq!(name, "files:upload");
        assert_eq!(external_args(sub), vec!["mon_fichier.pdf", "--token", "kubuno_xxx"]);
    }
}
