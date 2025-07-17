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

let temporaryKey = generateTemporaryKey();
let keyGenerationTime = Date.now();
const KEY_VALIDITY_DURATION = 12 * 60 * 60 * 1000;
function generateTemporaryKey() { return String(randomInt(1000, 9999)).padStart(4, '0'); }

app.post('/api/solicitudes', async (req, res) => {
  const solicitud = req.body;
  solicitud.estado_solicitud = 'Pendiente';
  const { data, error } = await supabase.from('solicitudes').insert(solicitud);
  if (error) { console.error("Error en /api/solicitudes:", error); return res.status(400).json({ error: error.message }); }
  res.status(201).json({ message: 'Solicitud creada con éxito', data: data });
});

app.get('/api/solicitudes/pendientes', async (req, res) => {
    const { data, error } = await supabase.from('solicitudes').select('*').eq('estado_solicitud', 'Planificada');
    if (error) { console.error("Error en /api/solicitudes/pendientes:", error); return res.status(500).json({ message: 'Error al obtener las solicitudes.' }); }
    res.json(data || []);
});

app.post('/api/reportes/instalacion', async (req, res) => {
    const reporteData = req.body;
    const numericFields = ['velocidad_descarga_mbps', 'velocidad_subida_mbps', 'potencia_nap', 'potencia_cliente', 'metraje_utilizado_m', 'metraje_desechado_m', 'tensores_utilizados'];
    numericFields.forEach(field => { if (reporteData[field] === '') { reporteData[field] = null; } });
    const solicitudId = reporteData.id_solicitud;
    if (solicitudId === 'FP-AUTO') {
        try {
            const { data: reportesAnteriores, error: busquedaError } = await supabase.from('reportes_instalacion').select('id_solicitud').like('id_solicitud', 'FP-%').order('created_at', { ascending: false }).limit(1);
            if (busquedaError) throw busquedaError;
            let nuevoNumero = 1;
            if (reportesAnteriores && reportesAnteriores.length > 0) { nuevoNumero = parseInt(reportesAnteriores[0].id_solicitud.split('-')[1]) + 1; }
            reporteData.id_solicitud = `FP-${nuevoNumero}`;
            const { data, error } = await supabase.from('reportes_instalacion').insert([reporteData]).select();
            if (error) throw error;
            return res.status(201).json({ message: 'Reporte de instalación rápida guardado!', data });
        } catch (error) {
            console.error("Error en reporte FP-AUTO:", error);
            return res.status(500).json({ message: 'Error al procesar reporte rápido.' });
        }
    }
    if (solicitudId && !isNaN(parseInt(solicitudId))) {
        const { data: reporteGuardado, error: errorReporte } = await supabase.from('reportes_instalacion').insert([reporteData]).select();
        if (errorReporte) { console.error("Error guardando reporte:", errorReporte); return res.status(500).json({ message: errorReporte.message }); }
        const { error: errorActualizacion } = await supabase.from('solicitudes').update({ estado_solicitud: 'Instalado' }).eq('id', solicitudId);
        if (errorActualizacion) { console.error("Error actualizando estado de solicitud:", errorActualizacion); return res.status(201).json({ message: 'Reporte guardado, pero hubo un error al actualizar el estado.', data: reporteGuardado }); }
        return res.status(201).json({ message: 'Reporte guardado y solicitud actualizada!', data: reporteGuardado });
    }
    return res.status(400).json({ message: 'ID de solicitud no válido.' });
});

app.get('/api/temporary-key', (req, res) => {
    const currentTime = Date.now();
    if (currentTime - keyGenerationTime > KEY_VALIDITY_DURATION) {
        temporaryKey = generateTemporaryKey(); keyGenerationTime = currentTime;
    }
    res.json({ key: temporaryKey });
});

app.get('/api/tecnicos', async (req, res) => {
  const { data, error } = await supabase.from('tecnicos').select('nombre');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

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
    if (!originalSolicitudId) return res.status(400).json({ error: "Falta el ID de la solicitud en los datos enviados." });
    assignmentData.solicitud_id = originalSolicitudId;
    delete assignmentData.id;
    const { error: upsertError } = await supabase.from('planificaciones').upsert({ ...assignmentData, estado_asignacion: 'Asignada' }, { onConflict: 'solicitud_id' });
    if (upsertError) {
        console.error('>>> ERROR EN UPSERT DE PLANIFICACIÓN!:', upsertError);
        return res.status(400).json({ error: `Error al crear/actualizar planificación: ${upsertError.message}` });
    }
    const { tecnico1, tecnico2, equipo } = assignmentData;
    const { error: updateError } = await supabase.from('solicitudes').update({ estado_solicitud: 'Planificada', equipo, tecnico_1: tecnico1, tecnico_2: tecnico2 }).eq('id', originalSolicitudId);
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});
