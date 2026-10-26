# Appmaz Audio — versión táctil V2

[Abrir la app](https://ciriquian.github.io/appmaz-audio/)

1. Introduce tu código de usuario y tu API key de OpenAI.
2. Elige GPT-5 Nano (razonamiento mínimo) o GPT-4.1 mini y configura tus listas.
3. Pulsa Usar lista: aparece la pantalla negra sin escuchar ni consultar Appmaz.
4. Mantén la pantalla pulsada UN SEGUNDO. Espera a Escuchando y habla.
5. Di la frase de detención. El resultado aparece en la pantalla negra y se envía inmediatamente por GET.
6. La app comprueba el resultado y reintenta cada segundo, hasta confirmarlo, durante un máximo de diez segundos. Estos reintentos no vuelven a llamar al modelo.
7. Para otra escucha, mantén un segundo. Para salir, mantén Volver DOS SEGUNDOS.

En Última sesión puedes revisar transcripción, resultado, errores y tiempos.

La API key y los ajustes se guardan en tu navegador; no hay claves en el repositorio.
Mantén la app abierta y el móvil desbloqueado. Puedes añadirla a la pantalla de inicio.

## Conexión desde GitHub Pages

La API de Appmaz debe permitir el origen https://ciriquian.github.io mediante CORS.
Si no lo permite, el resultado seguirá visible, pero el envío quedará pendiente de confirmación.
Lee LEEME.txt para los detalles.

La versión anterior se conserva en el historial de Git.
