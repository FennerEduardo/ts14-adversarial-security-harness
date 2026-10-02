# language: es
Característica: Creación de Pedido con Token de Autenticación

  Escenario: Creación exitosa de pedido
    Dado un usuario autenticado con ID "usr-sec-01"
    Cuando realiza un pedido con monto 150.00
    Entonces el pedido es procesado exitosamente
