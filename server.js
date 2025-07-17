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
app.get('/api/planificacion/:date(\\d{4}-\\d{2}-\\d{2})', async (req, res) => {
    const { date } = req.params;
    const [tecnicosRes, solicitudesRes] = await Promise.all([
        supabase.from('tecnicos').select('nombre'),
        supabase.from('solicitudes').select('*').eq('fecha_disponibilidad', date)
    ]);
    if (tecnicosRes.error || solicitudesRes.error) {
        console.error("Error en /api/planificacion/:date:", tecnicosRes.error || solicitudesRes.error);
        return res.status(500).json({ message: "Error al cargar datos del panel" });
    }
    res.json({
        technicians: tecnicosRes.data,
        solicitudes: solicitudesRes.data,
    });
});

app.post('/api/planificacion/assign', async (req, res) => {
    const assignmentData = req.body;
    const originalSolicitudId = assignmentData.id;

    if (!originalSolicitudId) {
        return res.status(400).json({ error: "Falta el ID de la solicitud en los datos enviados." });
    }

    assignmentData.solicitud_id = originalSolicitudId;
    delete assignmentData.id;

    const { error: upsertError } = await supabase
        .from('planificaciones')
        .upsert({ ...assignmentData, estado_asignacion: 'Asignada' }, { onConflict: 'solicitud_id' });
    
    if (upsertError) {
        console.error('>>> ERROR EN UPSERT DE PLANIFICACIÓN!:', upsertError);
        return res.status(400).json({ error: `Error al crear/actualizar planificación: ${upsertError.message}` });
    }

    const { tecnico1, tecnico2, equipo } = assignmentData;
    const { error: updateError } = await supabase.from('solicitudes').update({ 
        estado_solicitud: 'Planificada', 
        equipo, 
        tecnico_1: tecnico1, 
        tecnico_2: tecnico2 
    }).eq('id', originalSolicitudId);
    
    if (updateError) {
        console.error('>>> ERROR AL ACTUALIZAR LA SOLICITUD ORIGINAL!:', updateError);
        return res.status(400).json({ error: `Error al actualizar solicitud: ${updateError.message}` });
    }

    res.json({ result: 'success', message: 'Tarea planificada con éxito.' });
});

app.post('/api/planificacion/unassign', async (req, res) => {
    const { solicitud_id } = req.body;
    if (!solicitud_id) return res.status(400).json({ error: 'Falta el ID de la solicitud.' });
    const { error: deleteError } = await supabase.from('planificaciones').delete().eq('solicitud_id', solicitud_id);
    if (deleteError) { console.error("Error des-asignando (delete):", deleteError); return res.status(400).json({ error: `Error al borrar planificación: ${deleteError.message}` }); }
    const { error: updateError } = await supabase.from('solicitudes').update({ estado_solicitud: 'Pendiente', equipo: null, tecnico_1: null, tecnico_2: null }).eq('id', solicitud_id);
    if (updateError) { console.error("Error des-asignando (update):", updateError); return res.status(400).json({ error: `Error al actualizar solicitud: ${updateError.message}` }); }
    res.json({ result: 'success', message: 'Tarea devuelta a pendientes.' });
});

// ... aquí van el resto de tus endpoints como /api/solicitudes, /api/reportes/instalacion, etc. ...
// Asegúrate de que todo tu archivo server.js esté completo.

// --- INICIAR EL SERVIDOR ---
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});
