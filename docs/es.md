# Keycloak

[Keycloak](https://www.keycloak.org/) es un servidor libre de gestión de
identidades y accesos: inicio de sesión único (SSO), autenticación de dos
factores y federación de usuarios para los servicios de su hogar o de su
empresa. Esta integración lleva sus **eventos de seguridad** a Gladys: un
dispositivo por realm con los inicios de sesión fallidos y correctos del día,
los usuarios, las sesiones activas y las cuentas bloqueadas; escenas que se
disparan con un inicio de sesión fallido, una serie de fallos, una cuenta
bloqueada por la protección contra fuerza bruta o una acción de administración
sensible (para enviarse una notificación con el usuario y la dirección); y un
widget del panel con los últimos eventos.

Probada con un Keycloak 26.4.7 real (Docker, `start-dev`: un realm de prueba,
inicios de sesión correctos y fallidos hechos por la API OpenID Connect, un
bloqueo por la detección de fuerza bruta, usuarios y roles modificados por un
administrador). Desarrollada sin instalación de producción: sus comentarios
son bienvenidos en [las issues](https://github.com/guim31/gladys-keycloak/issues).

## Lo que necesita

- Gladys Assistant 5.1.0 o posterior.
- Keycloak, accesible desde la máquina de Gladys (su dirección pública, o su
  dirección local en el puerto 8080 u 8443). Probado con la 26.4; una versión
  más antigua con la misma API de administración debería funcionar.
- Los **eventos activados** en cada realm vigilado (abajo): por defecto,
  Keycloak no guarda ningún evento.
- Un **cliente confidencial con cuenta de servicio** y tres roles de lectura
  (abajo).

Gladys solo lee: nada en Keycloak se puede modificar desde Gladys.

## Primeros pasos

### 1. Activar los eventos del realm

En la consola de administración, elija el realm, luego **Realm settings →
Events**:

- pestaña **User events settings**: **Save events** activado. Los tipos por
  defecto incluyen `LOGIN`, `LOGIN_ERROR` y los bloqueos. Keycloak los guarda
  durante la caducidad fijada allí: hace falta al menos un día para los
  contadores de 24 horas;
- pestaña **Admin events settings**: **Save events** activado, e **Include
  representation** activado, para que Gladys sepa qué usuario se creó y qué
  roles se asignaron (sin ello, un rol de admin no se distingue de otro).

Para el disparador «Cuenta bloqueada»: **Realm settings → Security defenses →
Brute force detection**, elija un modo (bloqueo temporal o permanente).

### 2. Crear el cliente

**Clients → Create client**: tipo OpenID Connect, client ID `gladys`. Página
siguiente: **Client authentication** activado, marque solo **Service accounts
roles** (desmarque «Standard flow» y «Direct access grants»). Guarde y copie
el secreto de la pestaña **Credentials**.

### 3. Darle los roles de lectura

En el cliente, pestaña **Service accounts roles → Assign role → Filter by
clients**, busque `realm-management` y añada:

- `view-events` (eventos de usuario y de administración, bloqueos);
- `view-users` (los usuarios, el estado de fuerza bruta de una cuenta);
- `view-realm` (las sesiones).

**Varios realms**: cree el cliente en el realm `master`, y añada estos tres
roles desde el cliente `<realm>-realm` de cada realm vigilado (por ejemplo
`home-realm`). Un cliente de master obtiene también la versión de Keycloak,
que Keycloak oculta a los clientes de los demás realms.

### 4. Configurar la integración

En Gladys, **Integraciones → Keycloak → Configuración**:

- **Dirección de Keycloak**: por ejemplo `https://sso.example.com` (con
  `/auth` para Keycloak 16 y anteriores).
- **Realms que vigilar**: por ejemplo `casa`, o `casa, familia` (distingue
  mayúsculas).
- **Realm del cliente**: vacío cuando el cliente está en el primer realm
  vigilado, `master` si no.
- **ID del cliente** y **Secreto del cliente**: los del paso 2.
- **Fallos para una serie** y **Ventana de la serie**: la regla del disparador
  «Serie de inicios de sesión fallidos», 5 fallos en 10 minutos por defecto.
- **Intervalo de actualización**: 1 minuto por defecto.
- **Idioma de los nombres**: idioma de los nombres de funciones y de la frase.

**Probar la conexión** lee Keycloak enseguida y resume lo que ve.

### 5. Añadir los dispositivos

En **Descubrimiento**, añada los dispositivos «Keycloak <realm>».

## El dispositivo

| Función                             | Lo que contiene                                             |
| ----------------------------------- | ----------------------------------------------------------- |
| `Accesible`                         | 1 cuando el realm se puede leer, 0 si no                    |
| `Inicios de sesión fallidos (1 h)`  | Inicios de sesión fallidos de la última hora                |
| `Inicios de sesión fallidos (24 h)` | Inicios de sesión fallidos de las últimas 24 horas          |
| `Inicios de sesión (24 h)`          | Inicios de sesión correctos de las últimas 24 horas         |
| `Usuarios`                          | Cuentas de usuario del realm (sin las cuentas de servicio)  |
| `Sesiones activas`                  | Sesiones activas, una por usuario y aplicación              |
| `Cuentas bloqueadas`                | Cuentas que la protección contra fuerza bruta bloquea ahora |
| `Versión`                           | Versión de Keycloak (solo con un cliente del realm master)  |

«Accesible» pasa a 0 tras dos lecturas fallidas seguidas: un reinicio de
Keycloak pasa desapercibido. Los contadores pueden disparar escenas como
cualquier sensor (por ejemplo «Inicios de sesión fallidos (1 h)» por encima
de 20).

## Panel

El widget **Seguridad Keycloak** muestra los inicios de sesión fallidos y
correctos de las últimas 24 horas y las cuentas bloqueadas, y luego los
últimos eventos (usuario, lo que pasó, realm cuando hay varios, hora).
**Actualizar** vuelve a leer Keycloak.

## Escenas

### Disparadores

- **Inicio de sesión fallido**: alguien ha escrito una contraseña incorrecta o
  un nombre de usuario desconocido. Filtros: el realm, el nombre de usuario.
  Variables: realm, nombre de usuario escrito, dirección, aplicación
  (cliente), código de error de Keycloak (`invalid_user_credentials`,
  `user_not_found`, `user_temporarily_disabled`…).
- **Serie de inicios de sesión fallidos**: los fallos de un realm alcanzan el
  número fijado en la configuración, dentro de su ventana. Se dispara una vez
  por serie, y de nuevo solo cuando la cuenta ha bajado del umbral. Filtro: el
  realm. Variables: realm, número de fallos, ventana, nombres de usuario y
  direcciones distintos, el último nombre de usuario y la última dirección.
- **Cuenta bloqueada**: la protección contra fuerza bruta bloquea una cuenta.
  Filtros: el realm, el nombre de usuario. Variables: realm, nombre de
  usuario, dirección del último fallo, bloqueo (`temporary` o `permanent`).
- **Acción de administración sensible**: en un realm, se asigna un rol de
  admin, se asigna otro rol, se crea o elimina un usuario, se crea, modifica o
  elimina un cliente, o se modifican los ajustes del realm. Filtros: el realm,
  el evento. Variables: realm, evento, operación, tipo de recurso, usuario,
  cliente o roles afectados (con «Include representation»), dirección del
  administrador.

Los nombres de usuario y las direcciones son datos personales: se pasan a sus
escenas (para escribir una notificación) y se muestran en el widget, nunca se
escriben en los registros de la integración en el nivel info.

### Acciones

- **Estado de Keycloak**: resume Keycloak para un mensaje: inicios de sesión
  fallidos en 1 hora y 24 horas, inicios de sesión, cuentas bloqueadas,
  usuarios, sesiones activas, versión, el último nombre y la última dirección
  fallidos, y una frase lista («Keycloak: 5 inicio(s) de sesión fallido(s) en
  1 h, 5 en 24 h, 1 inicio(s) de sesión en 24 h, 1 cuenta(s) bloqueada(s), 2
  usuario(s)»).

### Ideas de escenas

- **Cuenta bloqueada** → una notificación «{{triggerEvent.data.username}} está
  bloqueada tras demasiados fallos ({{triggerEvent.data.ip}})».
- **Acción de administración sensible** con el evento «Rol de admin asignado»
  → una notificación inmediata, sea la hora que sea.
- **Serie de inicios de sesión fallidos** → una notificación, y la luz de la
  entrada parpadea en rojo si no hay nadie en casa.
- Cada noche, **Estado de Keycloak** → la frase en un mensaje.

## Solución de problemas

- **«cliente rechazado»**: el ID del cliente o el secreto son incorrectos,
  «Client authentication» está desactivado, o «Service accounts roles» no está
  marcado. Revise también el **Realm del cliente**.
- **«falta un rol a la cuenta de servicio»**: falta `view-events`. «usuarios
  ilegibles», «sesiones ilegibles» o «bloqueos ilegibles» en la prueba: falta
  `view-users` o `view-realm`.
- **«realm no encontrado»**: el nombre del realm distingue mayúsculas (`Casa`
  no es `casa`).
- **Ningún evento**: los eventos no se guardan en el realm (paso 1), o han
  caducado.
- **«TLS rechazado»**: Keycloak usa un certificado autofirmado, o se escribió
  `https://` para el puerto HTTP 8080. Use su dirección local en
  `http://…:8080`, o un certificado reconocido.
- **«no hay Keycloak en esta dirección»**: revise la dirección (la que usa
  para abrir la consola de administración, sin `/admin/…`). Keycloak 16 y
  anteriores necesitan `/auth`.
- **Versión vacía**: normal con un cliente fuera de master.
- Registros detallados: ponga `LOG_LEVEL=debug` en el contenedor.

## Límites

- Como máximo 1000 eventos por realm y por lectura, 3000 en la primera
  lectura. Por encima (un ataque masivo), los contadores son mínimos.
- Como máximo 10 eventos de escena por disparador y por lectura: un ataque
  nunca envía cientos de notificaciones.
- Lo que pasó mientras la integración estaba parada se anuncia en el siguiente
  arranque (dentro de las últimas 24 horas, ya que la hora del último evento se
  guarda en `/data`); el primer arranque no anuncia nada.
- Cada renovación del token (cada 5 minutos por defecto) escribe un evento
  `CLIENT_LOGIN` en el realm del cliente: unos 300 al día.
- Como máximo 10 realms. El dispositivo de un realm va ligado a su nombre:
  renombrar el realm crea otro dispositivo.
- Solo se siguen los inicios de sesión, los bloqueos y las acciones de
  administración citadas arriba, no los cierres de sesión, las renovaciones de
  token ni los proveedores de identidad.

Sin relación con el proyecto Keycloak, la Cloud Native Computing Foundation
ni Red Hat.
