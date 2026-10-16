//! Localised transactional message templates.
//!
//! Deliberately *not* a template engine: transactional mail is four fixed
//! layouts with a handful of slots, and shipping a runtime engine would mean
//! shipping a way for a stored string to become executable markup. What is here
//! instead is a table of translated sentences per locale plus one HTML shell,
//! with `{placeholder}` substitution and HTML escaping of every interpolated
//! value.
//!
//! Adding a locale = one row in [`STRINGS`]. Adding a message = one variant of
//! [`Template`] plus its fields in [`Strings`]; the compiler then refuses to
//! build until all thirteen locales carry it, which is what stops a translation
//! from silently falling back to English forever.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use super::config::MailConfig;
use crate::settings::intl;

/// The thirteen locales the frontend ships (`core/i18n/index.ts`). Kept in the
/// same order for eyeball diffing.
pub const LOCALES: [&str; 13] = [
    "en", "fr", "es", "pt", "it", "de", "el", "ru", "ar", "he", "hi", "zh", "ja",
];

/// When a message was produced, and the zone it is stated in.
///
/// Carried explicitly rather than read from the clock inside [`render`] so the
/// rendering stays a pure function of its inputs - which is what lets the tests
/// below assert an exact string instead of a regular expression.
#[derive(Debug, Clone, Copy)]
pub struct Stamp {
    pub at:       DateTime<Utc>,
    pub timezone: Tz,
}

impl Stamp {
    /// Now, stated in `timezone`.
    pub fn now(timezone: Tz) -> Self {
        Self { at: Utc::now(), timezone }
    }

    fn text(&self) -> String {
        intl::format_stamp(self.at, self.timezone)
    }
}

/// Falls back to English for an unknown or empty locale, and accepts regional
/// forms (`fr-CA` → `fr`).
///
/// Rendering is the one place where falling back is the right answer: a message
/// must go out in *some* language. Deciding whether a value is usable at all is
/// [`crate::settings::intl::normalise_locale`]'s job.
pub fn normalise_locale(locale: &str) -> &'static str {
    intl::normalise_locale(locale).unwrap_or("en")
}

/// One message to render.
pub enum Template<'a> {
    /// User-initiated "I forgot my password".
    PasswordReset { link: &'a str, hours: i64 },
    /// Invitation to join the instance.
    Invite { link: &'a str, inviter: &'a str, hours: i64 },
    /// An administrator reset the account's password and chose to mail it.
    AdminPasswordReset { password: &'a str, must_change: bool, link: &'a str },
    /// "Send a test email" from the relay settings screen.
    Test,
}

/// A rendered message: what [`super::send::Outgoing`] needs.
pub struct Rendered {
    pub subject: String,
    pub html:    String,
    pub text:    String,
}

/// Every translatable sentence, once per locale.
struct Strings {
    dir:  &'static str,
    greeting: &'static str,
    greeting_anonymous: &'static str,
    footer: &'static str,
    link_fallback: &'static str,
    expiry: &'static str,

    reset_subject: &'static str,
    reset_intro:   &'static str,
    reset_cta:     &'static str,
    reset_ignore:  &'static str,

    invite_subject: &'static str,
    invite_intro:   &'static str,
    invite_cta:     &'static str,

    admin_subject:      &'static str,
    admin_intro:        &'static str,
    admin_password:     &'static str,
    admin_must_change:  &'static str,
    admin_advice:       &'static str,
    admin_cta:          &'static str,

    test_subject: &'static str,
    test_intro:   &'static str,
}

/// Placeholders used below: `{instance}`, `{name}`, `{hours}`, `{inviter}`.
const STRINGS: [(&str, Strings); 13] = [
    ("en", Strings {
        dir: "ltr",
        greeting: "Hello {name},",
        greeting_anonymous: "Hello,",
        footer: "This message was sent automatically by {instance}. Please do not reply.",
        link_fallback: "If the button does not work, copy this address into your browser:",
        expiry: "This link is valid for {hours} hours and can only be used once.",
        reset_subject: "Reset your {instance} password",
        reset_intro: "A password reset was requested for your {instance} account.",
        reset_cta: "Reset my password",
        reset_ignore: "If you did not ask for this, simply ignore this message: your password remains unchanged.",
        invite_subject: "You have been invited to {instance}",
        invite_intro: "{inviter} invites you to join {instance}.",
        invite_cta: "Accept the invitation",
        admin_subject: "Your {instance} password has been reset",
        admin_intro: "An administrator has reset the password of your {instance} account.",
        admin_password: "New password",
        admin_must_change: "You will be asked to choose a new password the next time you sign in.",
        admin_advice: "Change this password as soon as you sign in, and never reuse it elsewhere.",
        admin_cta: "Sign in",
        test_subject: "{instance} - test message",
        test_intro: "This test message confirms that the outgoing mail relay of {instance} is correctly configured.",
    }),
    ("fr", Strings {
        dir: "ltr",
        greeting: "Bonjour {name},",
        greeting_anonymous: "Bonjour,",
        footer: "Message envoyé automatiquement par {instance}. Merci de ne pas y répondre.",
        link_fallback: "Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :",
        expiry: "Ce lien est valable {hours} heures et ne peut servir qu'une seule fois.",
        reset_subject: "Réinitialisation de votre mot de passe {instance}",
        reset_intro: "Une réinitialisation de mot de passe a été demandée pour votre compte {instance}.",
        reset_cta: "Réinitialiser mon mot de passe",
        reset_ignore: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.",
        invite_subject: "Vous êtes invité sur {instance}",
        invite_intro: "{inviter} vous invite à rejoindre {instance}.",
        invite_cta: "Accepter l'invitation",
        admin_subject: "Votre mot de passe {instance} a été réinitialisé",
        admin_intro: "Un administrateur a réinitialisé le mot de passe de votre compte {instance}.",
        admin_password: "Nouveau mot de passe",
        admin_must_change: "Un nouveau mot de passe vous sera demandé à votre prochaine connexion.",
        admin_advice: "Changez ce mot de passe dès votre connexion et ne le réutilisez nulle part ailleurs.",
        admin_cta: "Se connecter",
        test_subject: "{instance} - message de test",
        test_intro: "Ce message de test confirme que le relais de courrier sortant de {instance} est correctement configuré.",
    }),
    ("es", Strings {
        dir: "ltr",
        greeting: "Hola {name}:",
        greeting_anonymous: "Hola:",
        footer: "Mensaje enviado automáticamente por {instance}. Por favor, no responda.",
        link_fallback: "Si el botón no funciona, copie esta dirección en su navegador:",
        expiry: "Este enlace es válido durante {hours} horas y solo puede usarse una vez.",
        reset_subject: "Restablecer su contraseña de {instance}",
        reset_intro: "Se ha solicitado restablecer la contraseña de su cuenta de {instance}.",
        reset_cta: "Restablecer mi contraseña",
        reset_ignore: "Si no ha solicitado esto, ignore este mensaje: su contraseña permanece sin cambios.",
        invite_subject: "Le han invitado a {instance}",
        invite_intro: "{inviter} le invita a unirse a {instance}.",
        invite_cta: "Aceptar la invitación",
        admin_subject: "Se ha restablecido su contraseña de {instance}",
        admin_intro: "Un administrador ha restablecido la contraseña de su cuenta de {instance}.",
        admin_password: "Nueva contraseña",
        admin_must_change: "Se le pedirá que elija una nueva contraseña la próxima vez que inicie sesión.",
        admin_advice: "Cambie esta contraseña en cuanto inicie sesión y no la reutilice en ningún otro sitio.",
        admin_cta: "Iniciar sesión",
        test_subject: "{instance} - mensaje de prueba",
        test_intro: "Este mensaje de prueba confirma que el relé de correo saliente de {instance} está correctamente configurado.",
    }),
    ("pt", Strings {
        dir: "ltr",
        greeting: "Olá {name},",
        greeting_anonymous: "Olá,",
        footer: "Mensagem enviada automaticamente por {instance}. Por favor, não responda.",
        link_fallback: "Se o botão não funcionar, copie este endereço para o seu navegador:",
        expiry: "Esta ligação é válida durante {hours} horas e só pode ser utilizada uma vez.",
        reset_subject: "Redefinir a sua palavra-passe {instance}",
        reset_intro: "Foi pedida a redefinição da palavra-passe da sua conta {instance}.",
        reset_cta: "Redefinir a minha palavra-passe",
        reset_ignore: "Se não fez este pedido, ignore esta mensagem: a sua palavra-passe permanece inalterada.",
        invite_subject: "Foi convidado para {instance}",
        invite_intro: "{inviter} convida-o a juntar-se a {instance}.",
        invite_cta: "Aceitar o convite",
        admin_subject: "A sua palavra-passe {instance} foi redefinida",
        admin_intro: "Um administrador redefiniu a palavra-passe da sua conta {instance}.",
        admin_password: "Nova palavra-passe",
        admin_must_change: "Ser-lhe-á pedido que escolha uma nova palavra-passe no próximo início de sessão.",
        admin_advice: "Altere esta palavra-passe assim que iniciar sessão e nunca a reutilize noutro local.",
        admin_cta: "Iniciar sessão",
        test_subject: "{instance} - mensagem de teste",
        test_intro: "Esta mensagem de teste confirma que o relé de correio de saída de {instance} está corretamente configurado.",
    }),
    ("it", Strings {
        dir: "ltr",
        greeting: "Ciao {name},",
        greeting_anonymous: "Ciao,",
        footer: "Messaggio inviato automaticamente da {instance}. Si prega di non rispondere.",
        link_fallback: "Se il pulsante non funziona, copia questo indirizzo nel tuo browser:",
        expiry: "Questo collegamento è valido {hours} ore e può essere usato una sola volta.",
        reset_subject: "Reimposta la tua password {instance}",
        reset_intro: "È stata richiesta la reimpostazione della password del tuo account {instance}.",
        reset_cta: "Reimposta la mia password",
        reset_ignore: "Se non hai richiesto tu questa operazione, ignora questo messaggio: la tua password resta invariata.",
        invite_subject: "Sei stato invitato su {instance}",
        invite_intro: "{inviter} ti invita a unirti a {instance}.",
        invite_cta: "Accetta l'invito",
        admin_subject: "La tua password {instance} è stata reimpostata",
        admin_intro: "Un amministratore ha reimpostato la password del tuo account {instance}.",
        admin_password: "Nuova password",
        admin_must_change: "Al prossimo accesso ti sarà chiesto di scegliere una nuova password.",
        admin_advice: "Cambia questa password appena effettui l'accesso e non riutilizzarla altrove.",
        admin_cta: "Accedi",
        test_subject: "{instance} - messaggio di prova",
        test_intro: "Questo messaggio di prova conferma che il relay di posta in uscita di {instance} è configurato correttamente.",
    }),
    ("de", Strings {
        dir: "ltr",
        greeting: "Hallo {name},",
        greeting_anonymous: "Hallo,",
        footer: "Diese Nachricht wurde automatisch von {instance} gesendet. Bitte antworten Sie nicht darauf.",
        link_fallback: "Falls die Schaltfläche nicht funktioniert, kopieren Sie diese Adresse in Ihren Browser:",
        expiry: "Dieser Link ist {hours} Stunden gültig und kann nur einmal verwendet werden.",
        reset_subject: "Ihr {instance}-Passwort zurücksetzen",
        reset_intro: "Für Ihr {instance}-Konto wurde das Zurücksetzen des Passworts angefordert.",
        reset_cta: "Mein Passwort zurücksetzen",
        reset_ignore: "Falls Sie das nicht angefordert haben, ignorieren Sie diese Nachricht: Ihr Passwort bleibt unverändert.",
        invite_subject: "Sie wurden zu {instance} eingeladen",
        invite_intro: "{inviter} lädt Sie ein, {instance} beizutreten.",
        invite_cta: "Einladung annehmen",
        admin_subject: "Ihr {instance}-Passwort wurde zurückgesetzt",
        admin_intro: "Ein Administrator hat das Passwort Ihres {instance}-Kontos zurückgesetzt.",
        admin_password: "Neues Passwort",
        admin_must_change: "Bei der nächsten Anmeldung werden Sie aufgefordert, ein neues Passwort zu wählen.",
        admin_advice: "Ändern Sie dieses Passwort direkt nach der Anmeldung und verwenden Sie es nirgendwo sonst.",
        admin_cta: "Anmelden",
        test_subject: "{instance} - Testnachricht",
        test_intro: "Diese Testnachricht bestätigt, dass der ausgehende Mail-Relay von {instance} korrekt konfiguriert ist.",
    }),
    ("el", Strings {
        dir: "ltr",
        greeting: "Γεια σας {name},",
        greeting_anonymous: "Γεια σας,",
        footer: "Αυτό το μήνυμα στάλθηκε αυτόματα από το {instance}. Παρακαλούμε μην απαντήσετε.",
        link_fallback: "Αν το κουμπί δεν λειτουργεί, αντιγράψτε αυτή τη διεύθυνση στο πρόγραμμα περιήγησής σας:",
        expiry: "Αυτός ο σύνδεσμος ισχύει για {hours} ώρες και μπορεί να χρησιμοποιηθεί μόνο μία φορά.",
        reset_subject: "Επαναφορά του κωδικού σας στο {instance}",
        reset_intro: "Ζητήθηκε επαναφορά κωδικού πρόσβασης για τον λογαριασμό σας στο {instance}.",
        reset_cta: "Επαναφορά του κωδικού μου",
        reset_ignore: "Αν δεν το ζητήσατε εσείς, αγνοήστε αυτό το μήνυμα: ο κωδικός σας παραμένει αμετάβλητος.",
        invite_subject: "Προσκληθήκατε στο {instance}",
        invite_intro: "Ο/Η {inviter} σας προσκαλεί να συμμετάσχετε στο {instance}.",
        invite_cta: "Αποδοχή πρόσκλησης",
        admin_subject: "Ο κωδικός σας στο {instance} επαναφέρθηκε",
        admin_intro: "Ένας διαχειριστής επανέφερε τον κωδικό πρόσβασης του λογαριασμού σας στο {instance}.",
        admin_password: "Νέος κωδικός πρόσβασης",
        admin_must_change: "Στην επόμενη σύνδεση θα σας ζητηθεί να επιλέξετε νέο κωδικό πρόσβασης.",
        admin_advice: "Αλλάξτε αυτόν τον κωδικό μόλις συνδεθείτε και μην τον χρησιμοποιήσετε πουθενά αλλού.",
        admin_cta: "Σύνδεση",
        test_subject: "{instance} - δοκιμαστικό μήνυμα",
        test_intro: "Αυτό το δοκιμαστικό μήνυμα επιβεβαιώνει ότι ο διακομιστής εξερχόμενης αλληλογραφίας του {instance} έχει ρυθμιστεί σωστά.",
    }),
    ("ru", Strings {
        dir: "ltr",
        greeting: "Здравствуйте, {name}!",
        greeting_anonymous: "Здравствуйте!",
        footer: "Это сообщение отправлено автоматически системой {instance}. Пожалуйста, не отвечайте на него.",
        link_fallback: "Если кнопка не работает, скопируйте этот адрес в браузер:",
        expiry: "Ссылка действительна {hours} ч. и может быть использована только один раз.",
        reset_subject: "Сброс пароля в {instance}",
        reset_intro: "Для вашей учётной записи в {instance} запрошен сброс пароля.",
        reset_cta: "Сбросить пароль",
        reset_ignore: "Если вы этого не запрашивали, просто проигнорируйте это письмо: пароль останется прежним.",
        invite_subject: "Вас пригласили в {instance}",
        invite_intro: "{inviter} приглашает вас присоединиться к {instance}.",
        invite_cta: "Принять приглашение",
        admin_subject: "Ваш пароль в {instance} сброшен",
        admin_intro: "Администратор сбросил пароль вашей учётной записи в {instance}.",
        admin_password: "Новый пароль",
        admin_must_change: "При следующем входе вам будет предложено выбрать новый пароль.",
        admin_advice: "Смените этот пароль сразу после входа и не используйте его больше нигде.",
        admin_cta: "Войти",
        test_subject: "{instance} - тестовое сообщение",
        test_intro: "Это тестовое сообщение подтверждает, что ретранслятор исходящей почты {instance} настроен правильно.",
    }),
    ("ar", Strings {
        dir: "rtl",
        greeting: "مرحبًا {name}،",
        greeting_anonymous: "مرحبًا،",
        footer: "أُرسلت هذه الرسالة تلقائيًا من {instance}. يُرجى عدم الرد عليها.",
        link_fallback: "إذا لم يعمل الزر، فانسخ هذا العنوان إلى متصفحك:",
        expiry: "هذا الرابط صالح لمدة {hours} ساعة ولا يمكن استخدامه إلا مرة واحدة.",
        reset_subject: "إعادة تعيين كلمة المرور في {instance}",
        reset_intro: "تم طلب إعادة تعيين كلمة المرور لحسابك في {instance}.",
        reset_cta: "إعادة تعيين كلمة المرور",
        reset_ignore: "إذا لم تطلب ذلك، فتجاهل هذه الرسالة: ستبقى كلمة المرور دون تغيير.",
        invite_subject: "لقد تمت دعوتك إلى {instance}",
        invite_intro: "يدعوك {inviter} للانضمام إلى {instance}.",
        invite_cta: "قبول الدعوة",
        admin_subject: "تمت إعادة تعيين كلمة المرور الخاصة بك في {instance}",
        admin_intro: "قام أحد المسؤولين بإعادة تعيين كلمة مرور حسابك في {instance}.",
        admin_password: "كلمة المرور الجديدة",
        admin_must_change: "سيُطلب منك اختيار كلمة مرور جديدة عند تسجيل الدخول التالي.",
        admin_advice: "غيّر كلمة المرور هذه فور تسجيل الدخول ولا تستخدمها في أي مكان آخر.",
        admin_cta: "تسجيل الدخول",
        test_subject: "{instance} - رسالة اختبار",
        test_intro: "تؤكد رسالة الاختبار هذه أن مُرحّل البريد الصادر في {instance} مُهيّأ بشكل صحيح.",
    }),
    ("he", Strings {
        dir: "rtl",
        greeting: "שלום {name},",
        greeting_anonymous: "שלום,",
        footer: "הודעה זו נשלחה אוטומטית על ידי {instance}. נא לא להשיב עליה.",
        link_fallback: "אם הכפתור אינו פועל, העתיקו כתובת זו לדפדפן שלכם:",
        expiry: "קישור זה תקף למשך {hours} שעות וניתן להשתמש בו פעם אחת בלבד.",
        reset_subject: "איפוס הסיסמה שלך ב־{instance}",
        reset_intro: "התקבלה בקשה לאיפוס הסיסמה של חשבונך ב־{instance}.",
        reset_cta: "איפוס הסיסמה שלי",
        reset_ignore: "אם לא ביקשתם זאת, התעלמו מהודעה זו: הסיסמה שלכם נשארת ללא שינוי.",
        invite_subject: "הוזמנתם אל {instance}",
        invite_intro: "{inviter} מזמין אתכם להצטרף אל {instance}.",
        invite_cta: "אישור ההזמנה",
        admin_subject: "הסיסמה שלך ב־{instance} אופסה",
        admin_intro: "מנהל מערכת איפס את הסיסמה של חשבונך ב־{instance}.",
        admin_password: "סיסמה חדשה",
        admin_must_change: "בכניסה הבאה תתבקשו לבחור סיסמה חדשה.",
        admin_advice: "שנו סיסמה זו מיד עם הכניסה ואל תשתמשו בה בשום מקום אחר.",
        admin_cta: "התחברות",
        test_subject: "{instance} - הודעת בדיקה",
        test_intro: "הודעת בדיקה זו מאשרת שממסר הדואר היוצא של {instance} מוגדר כראוי.",
    }),
    ("hi", Strings {
        dir: "ltr",
        greeting: "नमस्ते {name},",
        greeting_anonymous: "नमस्ते,",
        footer: "यह संदेश {instance} द्वारा स्वचालित रूप से भेजा गया है। कृपया उत्तर न दें।",
        link_fallback: "यदि बटन काम न करे, तो यह पता अपने ब्राउज़र में कॉपी करें:",
        expiry: "यह लिंक {hours} घंटे के लिए वैध है और केवल एक बार उपयोग किया जा सकता है।",
        reset_subject: "अपना {instance} पासवर्ड रीसेट करें",
        reset_intro: "आपके {instance} खाते के लिए पासवर्ड रीसेट का अनुरोध किया गया है।",
        reset_cta: "मेरा पासवर्ड रीसेट करें",
        reset_ignore: "यदि आपने यह अनुरोध नहीं किया है, तो इस संदेश को अनदेखा करें: आपका पासवर्ड अपरिवर्तित रहेगा।",
        invite_subject: "आपको {instance} में आमंत्रित किया गया है",
        invite_intro: "{inviter} आपको {instance} से जुड़ने के लिए आमंत्रित करते हैं।",
        invite_cta: "निमंत्रण स्वीकार करें",
        admin_subject: "आपका {instance} पासवर्ड रीसेट कर दिया गया है",
        admin_intro: "एक व्यवस्थापक ने आपके {instance} खाते का पासवर्ड रीसेट कर दिया है।",
        admin_password: "नया पासवर्ड",
        admin_must_change: "अगली बार साइन इन करते समय आपसे नया पासवर्ड चुनने के लिए कहा जाएगा।",
        admin_advice: "साइन इन करते ही यह पासवर्ड बदल दें और इसे कहीं और दोबारा उपयोग न करें।",
        admin_cta: "साइन इन करें",
        test_subject: "{instance} - परीक्षण संदेश",
        test_intro: "यह परीक्षण संदेश पुष्टि करता है कि {instance} का आउटगोइंग मेल रिले सही ढंग से कॉन्फ़िगर किया गया है।",
    }),
    ("zh", Strings {
        dir: "ltr",
        greeting: "{name}，您好：",
        greeting_anonymous: "您好：",
        footer: "本邮件由 {instance} 自动发送，请勿回复。",
        link_fallback: "如果按钮无法使用，请将以下地址复制到浏览器中：",
        expiry: "该链接 {hours} 小时内有效，且仅可使用一次。",
        reset_subject: "重置您的 {instance} 密码",
        reset_intro: "有人为您的 {instance} 账户申请了密码重置。",
        reset_cta: "重置我的密码",
        reset_ignore: "如果这不是您本人的操作，请忽略此邮件：您的密码不会发生变化。",
        invite_subject: "您已被邀请加入 {instance}",
        invite_intro: "{inviter} 邀请您加入 {instance}。",
        invite_cta: "接受邀请",
        admin_subject: "您的 {instance} 密码已被重置",
        admin_intro: "管理员已重置您的 {instance} 账户密码。",
        admin_password: "新密码",
        admin_must_change: "下次登录时，系统将要求您设置新密码。",
        admin_advice: "登录后请立即修改此密码，切勿在其他地方重复使用。",
        admin_cta: "登录",
        test_subject: "{instance} - 测试邮件",
        test_intro: "这封测试邮件确认 {instance} 的外发邮件中继已正确配置。",
    }),
    ("ja", Strings {
        dir: "ltr",
        greeting: "{name} 様",
        greeting_anonymous: "こんにちは",
        footer: "このメールは {instance} から自動送信されています。返信はご遠慮ください。",
        link_fallback: "ボタンが動作しない場合は、次のアドレスをブラウザーに貼り付けてください:",
        expiry: "このリンクの有効期間は {hours} 時間で、一度しか使用できません。",
        reset_subject: "{instance} のパスワード再設定",
        reset_intro: "お使いの {instance} アカウントについて、パスワードの再設定が要求されました。",
        reset_cta: "パスワードを再設定する",
        reset_ignore: "心当たりがない場合は、このメールを無視してください。パスワードは変更されません。",
        invite_subject: "{instance} への招待",
        invite_intro: "{inviter} さんがあなたを {instance} に招待しています。",
        invite_cta: "招待を承認する",
        admin_subject: "{instance} のパスワードが再設定されました",
        admin_intro: "管理者があなたの {instance} アカウントのパスワードを再設定しました。",
        admin_password: "新しいパスワード",
        admin_must_change: "次回のサインイン時に、新しいパスワードの設定を求められます。",
        admin_advice: "サインイン後すぐにこのパスワードを変更し、他のサービスで再利用しないでください。",
        admin_cta: "サインイン",
        test_subject: "{instance} - テストメッセージ",
        test_intro: "このテストメッセージは、{instance} の送信メールリレーが正しく設定されていることを確認するものです。",
    }),
];

fn strings(locale: &str) -> &'static Strings {
    let want = normalise_locale(locale);
    STRINGS
        .iter()
        .find(|(code, _)| *code == want)
        .map(|(_, s)| s)
        // `STRINGS[0]` is English and `normalise_locale` already guarantees a
        // hit; the fallback only exists so this function has no panic path.
        .unwrap_or(&STRINGS[0].1)
}

/// Minimal HTML escaping for every interpolated value. Applied without
/// exception - an instance name, a display name and an inviter label are all
/// operator- or user-supplied strings.
fn esc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn fill(template: &str, slots: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (key, value) in slots {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    out
}

/// Body of a message, as a list of blocks. Rendered twice: once as HTML, once
/// as text, from the same source - so the two alternatives can never drift.
enum Block {
    Paragraph(String),
    /// Call-to-action button plus its raw URL (repeated for text clients).
    Button { label: String, href: String, fallback: String },
    /// A value the recipient must copy (a password). Monospaced, framed.
    Code { label: String, value: String },
    Muted(String),
}

fn render_html(dir: &str, instance: &str, blocks: &[Block]) -> String {
    let mut body = String::new();
    for block in blocks {
        match block {
            Block::Paragraph(text) => body.push_str(&format!(
                "<p style=\"margin:0 0 14px;font-size:15px;line-height:1.6;color:#202124\">{}</p>",
                esc(text)
            )),
            Block::Button { label, href, fallback } => body.push_str(&format!(
                "<p style=\"margin:22px 0\"><a href=\"{href}\" \
                 style=\"display:inline-block;padding:11px 22px;border-radius:8px;\
                 background:#1a73e8;color:#ffffff;font-size:15px;font-weight:500;\
                 text-decoration:none\">{label}</a></p>\
                 <p style=\"margin:0 0 14px;font-size:12px;line-height:1.6;color:#5f6368\">{fallback}<br>\
                 <a href=\"{href}\" style=\"color:#1a73e8;word-break:break-all\">{href}</a></p>",
                href = esc(href), label = esc(label), fallback = esc(fallback),
            )),
            Block::Code { label, value } => body.push_str(&format!(
                "<p style=\"margin:0 0 6px;font-size:12px;color:#5f6368\">{}</p>\
                 <p style=\"margin:0 0 18px;padding:12px 14px;border:1px solid #dadce0;\
                 border-radius:8px;background:#f8f9fa;font-family:ui-monospace,Menlo,\
                 Consolas,monospace;font-size:16px;color:#202124;word-break:break-all\">{}</p>",
                esc(label), esc(value)
            )),
            Block::Muted(text) => body.push_str(&format!(
                "<p style=\"margin:0 0 10px;font-size:12px;line-height:1.6;color:#5f6368\">{}</p>",
                esc(text)
            )),
        }
    }

    format!(
        "<div dir=\"{dir}\" style=\"margin:0;padding:24px;background:#f1f3f4;\
         font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif\">\
           <div style=\"max-width:560px;margin:0 auto;background:#ffffff;\
           border:1px solid #dadce0;border-radius:12px;padding:28px\">\
             <p style=\"margin:0 0 18px;font-size:17px;font-weight:500;color:#202124\">{instance}</p>\
             {body}\
           </div>\
         </div>",
        dir = esc(dir), instance = esc(instance),
    )
}

fn render_text(instance: &str, blocks: &[Block]) -> String {
    let mut out = format!("{instance}\n\n");
    for block in blocks {
        match block {
            Block::Paragraph(text) | Block::Muted(text) => {
                out.push_str(text);
                out.push_str("\n\n");
            }
            Block::Button { label, href, .. } => {
                out.push_str(&format!("{label} : {href}\n\n"));
            }
            Block::Code { label, value } => {
                out.push_str(&format!("{label} : {value}\n\n"));
            }
        }
    }
    out.trim_end().to_string()
}

/// Renders `tpl` for `locale`. `recipient_name` may be empty - the greeting
/// then drops the name instead of addressing "Hello ,".
///
/// `stamp` dates the message in the zone that applies to the recipient (see
/// [`crate::settings::intl`]). It is the one date a reader of a transactional
/// message actually needs - "was this reset request mine, ten minutes ago, or
/// somebody else's, last night?" - and stating it in UTC on an instance whose
/// operator has declared a zone answers the question in the wrong units.
pub fn render(
    locale: &str,
    instance: &str,
    recipient_name: &str,
    tpl: &Template<'_>,
    stamp: Stamp,
) -> Rendered {
    let s = strings(locale);
    let name = recipient_name.trim();
    let greeting = if name.is_empty() {
        s.greeting_anonymous.to_string()
    } else {
        fill(s.greeting, &[("name", name)])
    };
    let inst = &[("instance", instance)][..];

    let (subject, mut blocks) = match tpl {
        Template::PasswordReset { link, hours } => {
            let hours = hours.to_string();
            (
                fill(s.reset_subject, inst),
                vec![
                    Block::Paragraph(greeting),
                    Block::Paragraph(fill(s.reset_intro, inst)),
                    Block::Button {
                        label:    s.reset_cta.to_string(),
                        href:     (*link).to_string(),
                        fallback: s.link_fallback.to_string(),
                    },
                    Block::Muted(fill(s.expiry, &[("hours", &hours)])),
                    Block::Muted(s.reset_ignore.to_string()),
                ],
            )
        }
        Template::Invite { link, inviter, hours } => {
            let hours = hours.to_string();
            (
                fill(s.invite_subject, inst),
                vec![
                    Block::Paragraph(greeting),
                    Block::Paragraph(fill(
                        s.invite_intro,
                        &[("instance", instance), ("inviter", inviter)],
                    )),
                    Block::Button {
                        label:    s.invite_cta.to_string(),
                        href:     (*link).to_string(),
                        fallback: s.link_fallback.to_string(),
                    },
                    Block::Muted(fill(s.expiry, &[("hours", &hours)])),
                ],
            )
        }
        Template::AdminPasswordReset { password, must_change, link } => {
            let mut blocks = vec![
                Block::Paragraph(greeting),
                Block::Paragraph(fill(s.admin_intro, inst)),
                Block::Code {
                    label: s.admin_password.to_string(),
                    value: (*password).to_string(),
                },
            ];
            if *must_change {
                blocks.push(Block::Paragraph(s.admin_must_change.to_string()));
            }
            blocks.push(Block::Button {
                label:    s.admin_cta.to_string(),
                href:     (*link).to_string(),
                fallback: s.link_fallback.to_string(),
            });
            blocks.push(Block::Muted(s.admin_advice.to_string()));
            (fill(s.admin_subject, inst), blocks)
        }
        Template::Test => (
            fill(s.test_subject, inst),
            vec![
                Block::Paragraph(greeting),
                Block::Paragraph(fill(s.test_intro, inst)),
            ],
        ),
    };

    // Locale-independent by construction: a numeric instant plus the IANA name.
    // It therefore needs no fourteenth row in `STRINGS`, and it cannot be the
    // string that silently falls back to English for eleven languages.
    blocks.push(Block::Muted(stamp.text()));
    blocks.push(Block::Muted(fill(s.footer, inst)));

    Rendered {
        subject,
        html: render_html(s.dir, instance, &blocks),
        text: render_text(instance, &blocks),
    }
}

/// Fallback locale for a recipient whose preferences carry nothing usable.
pub const DEFAULT_LOCALE: &str = "en";

/// The language this account *chose*, or `None` when it never did.
///
/// The distinction is the whole point: "no preference" is not "English". An
/// account that never opened the language picker must be written to in the
/// language the instance - or its organisational unit - declares, and only a
/// `None` here lets the caller go and ask.
pub fn preferred_locale(preferences: &serde_json::Value) -> Option<&'static str> {
    preferences
        .get("language")
        .and_then(serde_json::Value::as_str)
        .and_then(intl::normalise_locale)
}

/// Reads a user's `preferences->>'language'`, normalised, falling back to
/// English. Kept for callers with no database at hand; anything that can reach
/// the settings should prefer [`preferred_locale`] plus
/// [`crate::settings::intl::locale_for`], which honours the instance and the
/// organisational unit before giving up on English.
pub fn locale_of(preferences: &serde_json::Value) -> &'static str {
    preferred_locale(preferences).unwrap_or(DEFAULT_LOCALE)
}

/// Subject line of the message the relay test sends, for the settings screen.
pub fn test_message(
    locale: &str,
    cfg: &MailConfig,
    recipient_name: &str,
    stamp: Stamp,
) -> Rendered {
    let instance = if cfg.from_name.trim().is_empty() { "Kubuno" } else { cfg.from_name.trim() };
    render(locale, instance, recipient_name, &Template::Test, stamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// A fixed instant so every assertion below is an exact string:
    /// 2026-08-04 13:32 UTC.
    fn stamp(tz: Tz) -> Stamp {
        Stamp {
            at: Utc.with_ymd_and_hms(2026, 8, 4, 13, 32, 0).single().expect("instant valide"),
            timezone: tz,
        }
    }

    fn utc() -> Stamp {
        stamp(Tz::UTC)
    }

    #[test]
    fn every_frontend_locale_has_a_row() {
        assert_eq!(STRINGS.len(), LOCALES.len());
        for locale in LOCALES {
            assert!(
                STRINGS.iter().any(|(code, _)| *code == locale),
                "locale {locale} absente de la table"
            );
        }
    }

    #[test]
    fn unknown_and_regional_locales_resolve() {
        assert_eq!(normalise_locale("fr-CA"), "fr");
        assert_eq!(normalise_locale("PT_BR"), "pt");
        assert_eq!(normalise_locale("kl"), "en");
        assert_eq!(normalise_locale(""), "en");
    }

    #[test]
    fn reset_mail_carries_the_link_in_both_alternatives() {
        let out = render(
            "fr", "Mon Cloud", "Alice",
            &Template::PasswordReset { link: "https://kubuno.test/reset?token=abc", hours: 2 },
            utc(),
        );
        assert!(out.subject.contains("Mon Cloud"));
        assert!(out.html.contains("https://kubuno.test/reset?token=abc"));
        assert!(out.text.contains("https://kubuno.test/reset?token=abc"));
        assert!(out.text.contains("Bonjour Alice,"));
        assert!(out.html.contains("2 heures"));
    }

    #[test]
    fn interpolated_values_are_html_escaped() {
        let out = render(
            "en", "<script>alert(1)</script>", "\"Bob\" & co",
            &Template::Test,
            utc(),
        );
        assert!(!out.html.contains("<script>"));
        assert!(out.html.contains("&lt;script&gt;"));
        assert!(out.html.contains("&quot;Bob&quot; &amp; co"));
    }

    #[test]
    fn anonymous_greeting_when_no_name_is_known() {
        let out = render("fr", "Kubuno", "   ", &Template::Test, utc());
        assert!(out.text.contains("Bonjour,"));
        assert!(!out.text.contains("Bonjour ,"));
    }

    #[test]
    fn rtl_locales_set_the_document_direction() {
        for locale in ["ar", "he"] {
            let out = render(locale, "Kubuno", "", &Template::Test, utc());
            assert!(out.html.contains("dir=\"rtl\""), "{locale} devrait être RTL");
        }
        assert!(render("fr", "Kubuno", "", &Template::Test, utc()).html.contains("dir=\"ltr\""));
    }

    #[test]
    fn admin_reset_mentions_the_forced_change_only_when_asked() {
        let with = render("en", "Kubuno", "Bob", &Template::AdminPasswordReset {
            password: "Zz9-quatre", must_change: true, link: "https://kubuno.test/login",
        }, utc());
        assert!(with.text.contains("choose a new password"));
        assert!(with.text.contains("Zz9-quatre"));

        let without = render("en", "Kubuno", "Bob", &Template::AdminPasswordReset {
            password: "Zz9-quatre", must_change: false, link: "https://kubuno.test/login",
        }, utc());
        assert!(!without.text.contains("choose a new password"));
    }

    #[test]
    fn no_placeholder_is_left_unreplaced() {
        for locale in LOCALES {
            for tpl in [
                Template::PasswordReset { link: "https://x.test/r", hours: 2 },
                Template::Invite { link: "https://x.test/i", inviter: "Alice", hours: 48 },
                Template::AdminPasswordReset { password: "p", must_change: true, link: "https://x.test/l" },
                Template::Test,
            ] {
                let out = render(locale, "Kubuno", "Bob", &tpl, utc());
                for slot in ["{instance}", "{name}", "{hours}", "{inviter}"] {
                    assert!(!out.subject.contains(slot), "{locale}: sujet contient {slot}");
                    assert!(!out.text.contains(slot), "{locale}: corps contient {slot}");
                }
            }
        }
    }

    #[test]
    fn locale_is_read_from_user_preferences() {
        assert_eq!(locale_of(&serde_json::json!({ "language": "ja" })), "ja");
        assert_eq!(locale_of(&serde_json::json!({ "language": "xx" })), "en");
        assert_eq!(locale_of(&serde_json::json!({})), "en");
    }

    #[test]
    fn an_account_with_no_language_is_distinguished_from_one_that_chose_english() {
        // The distinction the instance locale rests on: `None` sends the caller
        // to the instance (or the unit), `Some("en")` is a decision to respect.
        assert_eq!(preferred_locale(&serde_json::json!({ "language": "en" })), Some("en"));
        assert_eq!(preferred_locale(&serde_json::json!({})), None);
        assert_eq!(preferred_locale(&serde_json::json!({ "language": "xx" })), None);
        assert_eq!(preferred_locale(&serde_json::json!({ "language": "" })), None);
    }

    #[test]
    fn every_message_is_dated_in_the_zone_it_was_given() {
        for tpl in [
            Template::PasswordReset { link: "https://x.test/r", hours: 2 },
            Template::Invite { link: "https://x.test/i", inviter: "Alice", hours: 48 },
            Template::AdminPasswordReset { password: "p", must_change: true, link: "https://x.test/l" },
            Template::Test,
        ] {
            let out = render("fr", "Kubuno", "Bob", &tpl, stamp(Tz::Europe__Paris));
            assert!(
                out.text.contains("2026-08-04 15:32 (Europe/Paris)"),
                "l'horodatage manque dans le corps texte : {}",
                out.text,
            );
            assert!(out.html.contains("2026-08-04 15:32 (Europe/Paris)"));
        }
    }

    #[test]
    fn the_stamp_is_the_same_string_in_every_language() {
        // Numeric and locale-independent on purpose: it is the one line that
        // cannot fall back to English for eleven locales, because there is
        // nothing in it to translate.
        for locale in LOCALES {
            let out = render(locale, "Kubuno", "Bob", &Template::Test, stamp(Tz::Asia__Tokyo));
            assert!(out.text.contains("2026-08-04 22:32 (Asia/Tokyo)"), "{locale}");
        }
    }
}
