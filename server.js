// Cargar las herramientas
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { randomInt } = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Lógica de Clave Temporal
let temporaryKey = generateTemporaryKey();
let keyGenerationTime = Date.now();
const KEY_VALIDITY_DURATION = 12 * 60 * 60 * 1000;
function generateTemporaryKey() { return String(randomInt(1000, 9999)).padStart(4, '0'); }

// --- ENDPOINTS ---
app.post('/api/solicitudes', async (req, res) => {
  const solicitud = req.body;
  solicitud.estado_solicitud = 'Pendiente';
  const { data, error } = await supabase.from('solicitudes').insert(solicitud);
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Solicitud creada con éxito', data: data });
});

app.get('/api/solicitudes/pendientes', async (req, res) => {
    const { data, error } = await supabase.from('solicitudes').select('*').eq('estado_solicitud', 'Planificada');
    if (error) return res.status(500).json({ message: 'Error al obtener las solicitudes.' });
    res.json(data || []);
});

app.post('/api/reportes/instalacion', async (req, res) => {
    const reporteData = req.body;
    const solicitudId = reporteData.id_solicitud;
    if (solicitudId === 'FP-AUTO') {
        const { data: reportesAnteriores, error: busquedaError } = await supabase.from('reportes_instalacion').select('id_solicitud').like('id_solicitud', 'FP-%').order('created_at', { ascending: false }).limit(1);
        if (busquedaError) return res.status(500).json({ message: 'Error al generar ID de reporte.' });
        let nuevoNumero = 1;
        if (reportesAnteriores && reportesAnteriores.length > 0) {
            nuevoNumero = parseInt(reportesAnteriores[0].id_solicitud.split('-')[1]) + 1;
        }
        reporteData.id_solicitud = `FP-${nuevoNumero}`;
        const { data, error } = await supabase.from('reportes_instalacion').insert([reporteData]).select();
        if (error) return res.status(500).json({ message: error.message });
        return res.status(201).json({ message: 'Reporte de instalación rápida guardado!', data });
    }
    if (solicitudId && !isNaN(parseInt(solicitudId))) {
        const { data: reporteGuardado, error: errorReporte } = await supabase.from('reportes_instalacion').insert([reporteData]).select();
        if (errorReporte) return res.status(500).json({ message: errorReporte.message });
        const { error: errorActualizacion } = await supabase.from('solicitudes').update({ estado_solicitud: 'Instalado' }).eq('id', solicitudId);
        if (errorActualizacion) return res.status(201).json({ message: 'Reporte guardado, pero hubo un error al actualizar el estado.', data: reporteGuardado });
        return res.status(201).json({ message: 'Reporte guardado y solicitud actualizada!', data: reporteGuardado });
    }
    return res.status(400).json({ message: 'ID de solicitud no válido.' });
});

app.get('/api/temporary-key', (req, res) => {
    const currentTime = Date.now();
    if (currentTime - keyGenerationTime > KEY_VALIDITY_DURATION) {
        temporaryKey = generateTemporaryKey();
        keyGenerationTime = currentTime;
    }
    res.json({ key: temporaryKey });
});

app.post('/api/validate-temporary-key', (req, res) => {
    const { enteredKey } = req.body;
    if (enteredKey === temporaryKey) res.json({ valid: true });
    else res.status(401).json({ valid: false, message: 'Clave incorrecta.' });
});

// --- ENDPOINTS PARA EL PANEL DE ADMINISTRADOR ---
app.get('/api/planificacion/:date', async (req, res) => {
    const { date } = req.params;
    const [tecnicosRes, pendientesRes, planificadasRes] = await Promise.all([
        supabase.from('tecnicos').select('nombre'),
        supabase.from('solicitudes').select('*').eq('estado_solicitud', 'Pendiente').eq('fecha_disponibilidad', date),
        supabase.from('planificaciones').select('*').eq('fecha_asignada', date)
    ]);
    if (tecnicosRes.error || pendientesRes.error || planificadasRes.error) {
        return res.status(500).json({ message: "Error al cargar datos del panel" });
    }
    res.json({
        technicians: tecnicosRes.data,
        pendingInstallations: pendientesRes.data,
        plannedInstallations: planificadasRes.data
    });
});

app.post('/api/planificacion/assign', async (req, res) => {
    // req.body ahora contiene todos los datos de la tarjeta
    const { solicitud_id, equipo, tecnico1, tecnico2, fecha_asignada } = req.body;

    // 1. Preparamos el objeto completo para guardar en 'planificaciones'
    // El 'onConflict' se asegura de que si se reasigna, se actualice en lugar de crear un duplicado.
    const { error: upsertError } = await supabase
        .from('planificaciones')
        .upsert({ 
            ...req.body, // Guardamos todos los datos de la tarjeta
            estado_asignacion: 'Asignada'
        }, { onConflict: 'solicitud_id' });
    
    if (upsertError) {
        console.error('Error en upsert de planificación:', upsertError);
        return res.status(400).json({ error: `Error al crear/actualizar planificación: ${upsertError.message}` });
    }

    // 2. Actualizamos el estado en la tabla 'solicitudes'
    const { error: updateError } = await supabase.from('solicitudes').update({ 
        estado_solicitud: 'Planificada', 
        equipo, 
        tecnico_1: tecnico1, 
        tecnico_2: tecnico2 
    }).eq('id', solicitud_id);
    
    if (updateError) {
        console.error('Error al actualizar solicitud:', updateError);
        return res.status(400).json({ error: `Error al actualizar solicitud: ${updateError.message}` });
    }

    res.json({ result: 'success', message: 'Tarea planificada con éxito.' });
});

// --- INICIAR EL SERVIDOR ---
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});
