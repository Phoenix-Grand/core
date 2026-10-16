//! Auto-sandbox partagé : interdit l'exécution de tout programme externe.
//!
//! Objectif de sécurité : **aucun utilisateur de l'application ne doit pouvoir
//! exécuter de commande sur la machine qui héberge Kubuno.** Les modules qui ne
//! lancent jamais de binaire externe dans leur fonctionnement normal (PostgreSQL =
//! réseau, IPC = HTTP, Git = libgit2 en-process, crypto/images/JS = en-process)
//! appellent [`lock_down_process_execution`] au démarrage pour rendre cette
//! propriété **inviolable au niveau du noyau** : même une régression future, une
//! dépendance compromise ou une entrée piégée ne peut plus appeler `execve`.
//!
//! ⚠️ Ne PAS utiliser dans un module qui doit légitimement lancer des processus
//! (ex. `files` → curl/ssh/smbclient, `media` → ffmpeg/ffprobe).
//!
//! Implémentation : un programme BPF classique installé via `seccomp(2)` en mode
//! filtre, synchronisé sur tous les threads (`TSYNC`). `execve`/`execveat`
//! renvoient `EPERM` (et non un kill du processus) : une éventuelle tentative
//! échoue proprement au lieu de faire planter le module.

/// Installe le filtre seccomp interdisant `execve`/`execveat` pour le processus
/// courant. `module` n'est utilisé que pour le journal.
///
/// Sans effet (et sans erreur) sur les plateformes non Linux/x86-64, qui ne sont
/// pas des cibles de déploiement. En cas d'échec d'installation, journalise une
/// erreur et laisse le module continuer (dégradation sûre).
pub fn lock_down_process_execution(module: &str) {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        match install_filter() {
            Ok(()) => tracing::info!(
                module,
                "seccomp : exécution de processus (execve/execveat) interdite"
            ),
            Err(e) => tracing::error!(
                module,
                error = %e,
                "seccomp : impossible d'installer le filtre anti-exécution - le module continue sans cette protection"
            ),
        }
    }

    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        let _ = module;
        tracing::warn!("seccomp : plateforme non supportée, filtre anti-exécution non posé");
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn install_filter() -> Result<(), std::io::Error> {
    use std::mem::offset_of;

    // ── Constantes BPF / seccomp ──────────────────────────────────────────────
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;

    const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const EPERM: u32 = 1;

    const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
    const SECCOMP_FILTER_FLAG_TSYNC: libc::c_ulong = 1; // applique à tous les threads

    let nr_off = offset_of!(libc::seccomp_data, nr) as u32;
    let arch_off = offset_of!(libc::seccomp_data, arch) as u32;
    let nr_execve = libc::SYS_execve as u32;
    let nr_execveat = libc::SYS_execveat as u32;

    // ── Programme BPF ─────────────────────────────────────────────────────────
    // 0: charger l'architecture
    // 1: si arch != x86_64 → autoriser (on ne sait pas filtrer une autre ABI)
    // 3: charger le numéro de syscall
    // 4: si execve   → refuser (EPERM)
    // 5: si execveat → refuser (EPERM)
    // 6: sinon       → autoriser
    let filter = [
        sock_filter(BPF_LD | BPF_W | BPF_ABS, 0, 0, arch_off),
        sock_filter(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AUDIT_ARCH_X86_64),
        sock_filter(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
        sock_filter(BPF_LD | BPF_W | BPF_ABS, 0, 0, nr_off),
        sock_filter(BPF_JMP | BPF_JEQ | BPF_K, 2, 0, nr_execve),
        sock_filter(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, nr_execveat),
        sock_filter(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
        sock_filter(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EPERM),
    ];

    let prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr() as *mut libc::sock_filter,
    };

    // PR_SET_NO_NEW_PRIVS est requis pour poser un filtre seccomp sans être root,
    // et garantit qu'aucun exec ne pourra regagner de privilèges.
    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }

    let rc = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            SECCOMP_SET_MODE_FILTER,
            SECCOMP_FILTER_FLAG_TSYNC,
            &prog as *const libc::sock_fprog,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }

    Ok(())
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[inline]
fn sock_filter(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}
