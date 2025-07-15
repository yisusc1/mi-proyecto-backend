// Cargar las herramientas que instalamos
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// Crear la aplicación del servidor
const app = express();
const port = process.env.PORT || 3000;

// Configurar la aplicación
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Para servir los archivos HTML

// Conectar a la base de datos de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ----------------------------------------------------------------
// --- ENDPOINTS BÁSICOS Y DE FORMULARIOS -------------------------
// ----------------------------------------------------------------

// Endpoint de prueba
app.get('/', (req, res) => {
  res.send('¡El servidor funciona correctamente!');
});

// Endpoint para obtener la lista de todos los técnicos
app.get('/api/tecnicos', async (req, res) => {
  const { data, error } = await supabase.from('tecnicos').select('*');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Endpoint para recibir y guardar una nueva solicitud de servicio
app.post('/api/solicitudes', async (req, res) => {
  const solicitud = req.body;
  solicitud.estado_solicitud = 'Pendiente';
  const { data, error } = await supabase.from('solicitudes').insert(solicitud);
  if (error) {
    console.error('Error al insertar solicitud:', error);
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json({ message: 'Solicitud creada con éxito', data: data });
});

// Endpoint para recibir un reporte de instalación
app.post('/api/reportes/instalacion', async (req, res) => {
    const reporte = req.body;
    const { data, error } = await supabase.from('reportes_instalacion').insert(reporte);
    if (error) {
        console.error('Error al insertar reporte de instalación:', error);
        return res.status(400).json({ error: error.message });
    }
    res.status(201).json({ message: 'Reporte de instalación guardado', data: data });
});

// Endpoint para recibir un reporte de soporte
app.post('/api/reportes/soporte', async (req, res) => {
    const reporte = req.body;
    const { data, error } = await supabase.from('reportes_soporte').insert(reporte);
    if (error) {
        console.error('Error al insertar reporte de soporte:', error);
        return res.status(400).json({ error: error.message });
    }
    res.status(201).json({ message: 'Reporte de soporte guardado', data: data });
});


// ----------------------------------------------------------------
// --- ENDPOINTS PARA EL PANEL DE ADMINISTRADOR (PLANIFICACIÓN) ---
// ----------------------------------------------------------------

// Endpoint para obtener los datos iniciales del tablero Kanban para una fecha específica
app.get('/api/planificacion/:date', async (req, res) => {
    const { date } = req.params;

    const [tecnicosRes, pendientesRes, planificadasRes] = await Promise.all([
        supabase.from('tecnicos').select('*'),
        supabase.from('solicitudes').select('*').eq('estado_solicitud', 'Pendiente').eq('fecha_disponibilidad', date),
        supabase.from('planificaciones').select('*').eq('fecha_asignada', date)
    ]);

    if (tecnicosRes.error || pendientesRes.error || planificadasRes.error) {
        console.error('Error al cargar datos del panel:', tecnicosRes.error || pendientesRes.error || planificadasRes.error);
        return res.status(500).json({ message: "Error al cargar datos del panel" });
    }

    res.json({
        technicians: tecnicosRes.data,
        pendingInstallations: pendientesRes.data,
        plannedInstallations: planificadasRes.data
    });
});

// Endpoint para asignar una tarea a un equipo
app.post('/api/planificacion/assign', async (req, res) => {
    const { solicitud_id, equipo, tecnico1, tecnico2, fecha_asignada, nombre_cliente, sector } = req.body;

    // 1. Actualizar la solicitud
    const { error: updateError } = await supabase
        .from('solicitudes')
        .update({ estado_solicitud: `Planificada para ${equipo}` })
        .eq('id', solicitud_id);

    if (updateError) {
        console.error("<<<<< ¡ERROR EN EL SERVIDOR! al actualizar la solicitud >>>>>", updateError);
        return res.status(400).json({ error: `Error al actualizar solicitud: ${updateError.message}` });
    }
    
    // 2. Insertar en la planificación
    const { error: insertError } = await supabase
        .from('planificaciones')
        .insert({ solicitud_id, equipo, tecnico1, tecnico2, fecha_asignada, nombre_cliente, sector, estado_asignacion: 'Asignada' });

    if (insertError) {
        console.error("<<<<< ¡ERROR EN EL SERVIDOR! al crear la planificación >>>>>", insertError);
        return res.status(400).json({ error: `Error al crear planificación: ${insertError.message}` });
    }

    res.json({ result: 'success', message: 'Tarea asignada con éxito.' });
});

// Endpoint para des-asignar una tarea (VERSIÓN MEJORADA)
app.post('/api/planificacion/unassign', async (req, res) => {
    const { solicitud_id } = req.body;

    if (!solicitud_id) {
        return res.status(400).json({ error: 'Falta el ID de la solicitud.' });
    }

    // 1. Borrar el registro de la tabla 'planificaciones' PRIMERO.
    const { error: deleteError } = await supabase
        .from('planificaciones')
        .delete()
        .eq('solicitud_id', solicitud_id);
    
    if (deleteError) {
        console.error('Error al borrar planificación:', deleteError);
        return res.status(400).json({ error: `Error al borrar planificación: ${deleteError.message}` });
    }

    // 2. Si el borrado fue exitoso, actualizar el estado en 'solicitudes' a 'Pendiente'.
    const { error: updateError } = await supabase
        .from('solicitudes')
        .update({ estado_solicitud: 'Pendiente' })
        .eq('id', solicitud_id);

    if (updateError) {
        console.error('Error al actualizar solicitud a pendiente:', updateError);
        return res.status(400).json({ error: `Error al actualizar solicitud: ${updateError.message}` });
    }

    res.json({ result: 'success', message: 'Tarea devuelta a pendientes.' });
});

// ----------------------------------------------------------------
// --- ENDPOINT PARA FACTIBILIDAD ---------------------------------
// ----------------------------------------------------------------

// Función para calcular la distancia entre dos coordenadas (fórmula de Haversine)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Radio de la Tierra en metros
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distancia en metros
}

// Endpoint que recibe coordenadas de un cliente y devuelve la NAP más cercana
app.post('/api/factibilidad', async (req, res) => {
    const { latitud, longitud } = req.body;

    if (!latitud || !longitud) {
        return res.status(400).json({ error: 'Faltan coordenadas.' });
    }

    // 1. Obtener todas las NAPs de la base de datos
    const { data: naps, error } = await supabase.from('naps').select('*');

    if (error) {
        return res.status(500).json({ error: error.message });
    }
    if (!naps || naps.length === 0) {
        return res.status(404).json({ error: 'No se encontraron NAPs en la base de datos.' });
    }

    // 2. Calcular la distancia a cada NAP y encontrar la más cercana
    let closestNap = null;
    let minDistance = Infinity;

    naps.forEach(nap => {
        const distance = getDistanceInMeters(latitud, longitud, nap.latitud, nap.longitud);
        if (distance < minDistance) {
            minDistance = distance;
            closestNap = nap;
        }
    });

    // 3. Determinar si es factible (ej: si está a menos de 250 metros)
    const esFactible = minDistance <= 250;

    // 4. Devolver el resultado
    res.json({
        cliente: { latitud, longitud },
        nap_cercana: closestNap,
        distancia_metros: Math.round(minDistance),
        es_factible: esFactible
    });
});

// ----------------------------------------------------------------
// --- INICIAR EL SERVIDOR ----------------------------------------
// ----------------------------------------------------------------
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});