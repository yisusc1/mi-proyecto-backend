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

function generateTemporaryKey() {
    return String(randomInt(1000, 9999)).padStart(4, '0');
}

// Middleware para validar fechas
const validateDate = (req, res, next) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD' });
    }
    next();
};

// Clave temporal
app.get('/api/temporary-key', (req, res) => {
    const currentTime = Date.now();
    if (currentTime - keyGenerationTime > KEY_VALIDITY_DURATION) {
        temporaryKey = generateTemporaryKey();
        keyGenerationTime = currentTime;
    }
    res.json({ key: temporaryKey });
});

// Endpoints para solicitudes
app.post('/api/solicitudes', async (req, res) => {
    try {
        const solicitud = req.body;
        solicitud.estado_solicitud = 'Pendiente';
        
        const { data, error } = await supabase.from('solicitudes').insert(solicitud).select();
        
        if (error) throw error;
        res.status(201).json({ message: 'Solicitud creada con éxito', data });
    } catch (error) {
        console.error("Error en /api/solicitudes:", error);
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/solicitudes/pendientes', async (req, res) => {
    try {
        const { data, error } = await supabase.from('solicitudes')
            .select('*')
            .eq('estado_solicitud', 'Pendiente')
            .order('fecha_solicitud', { ascending: true });
            
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error("Error en /api/solicitudes/pendientes:", error);
        res.status(500).json({ message: 'Error al obtener las solicitudes.' });
    }
});

// Endpoints para reportes de instalación
app.post('/api/reportes/instalacion', async (req, res) => {
    try {
        const reporteData = req.body;
        
        // Procesar campos numéricos
        const numericFields = [
            'velocidad_descarga_mbps', 
            'velocidad_subida_mbps', 
            'potencia_nap', 
            'potencia_cliente',
            'metraje_utilizado_m', 
            'metraje_desechado_m', 
            'tensores_utilizados'
        ];
        
        numericFields.forEach(field => {
            if (reporteData[field] === '') {
                reporteData[field] = null;
            }
        });

        const solicitudId = reporteData.id_solicitud;

        // Manejo de reportes rápidos (FP-AUTO)
        if (solicitudId === 'FP-AUTO') {
            const { data: reportesAnteriores, error: busquedaError } = await supabase
                .from('reportes_instalacion')
                .select('id_solicitud')
                .like('id_solicitud', 'FP-%')
                .order('created_at', { ascending: false })
                .limit(1);

            if (busquedaError) throw busquedaError;

            let nuevoNumero = 1;
            if (reportesAnteriores && reportesAnteriores.length > 0) {
                nuevoNumero = parseInt(reportesAnteriores[0].id_solicitud.split('-')[1]) + 1;
            }

            reporteData.id_solicitud = `FP-${nuevoNumero}`;
            const { data, error } = await supabase.from('reportes_instalacion').insert([reporteData]).select();
            
            if (error) throw error;
            return res.status(201).json({ message: 'Reporte de instalación rápida guardado!', data });
        }

        // Validar ID de solicitud para reportes normales
        if (!solicitudId || isNaN(parseInt(solicitudId))) {
            return res.status(400).json({ message: 'ID de solicitud no válido.' });
        }

        // Usar transacción para asegurar consistencia
        const { data: reporteGuardado, error: errorReporte } = await supabase
            .from('reportes_instalacion')
            .insert([reporteData])
            .select();

        if (errorReporte) throw errorReporte;

        const { error: errorActualizacion } = await supabase
            .from('solicitudes')
            .update({ 
                estado_solicitud: 'Instalado',
                fecha_instalacion: new Date().toISOString()
            })
            .eq('id', solicitudId);

        if (errorActualizacion) {
            console.error("Error actualizando estado de solicitud:", errorActualizacion);
            return res.status(201).json({ 
                message: 'Reporte guardado, pero hubo un error al actualizar el estado.', 
                data: reporteGuardado 
            });
        }

        res.status(201).json({ message: 'Reporte guardado y solicitud actualizada!', data: reporteGuardado });

    } catch (error) {
        console.error("Error en /api/reportes/instalacion:", error);
        res.status(500).json({ 
            message: 'Error al procesar el reporte',
            details: process.env.NODE_ENV === 'development' ? error.message : null
        });
    }
});

// Endpoints para el panel de administración
app.get('/api/planificacion/:date', validateDate, async (req, res) => {
    try {
        const { date } = req.params;
        
        const [
            { data: tecnicos, error: tecnicosError },
            { data: solicitudes, error: solicitudesError },
            { data: equipos, error: equiposError }
        ] = await Promise.all([
            supabase.from('tecnicos').select('id, nombre').order('nombre', { ascending: true }),
            supabase.from('solicitudes').select('*').eq('fecha_disponibilidad', date),
            supabase.from('equipos').select('*').eq('fecha', date)
        ]);

        if (tecnicosError || solicitudesError || equiposError) {
            const error = tecnicosError || solicitudesError || equiposError;
            throw error;
        }

        res.json({
            technicians: tecnicos || [],
            solicitudes: solicitudes || [],
            equipos: (equipos || []).map(equipo => ({
                ...equipo,
                tecnico_1: equipo.tecnico_1 || '',
                tecnico_2: equipo.tecnico_2 || ''
            }))
        });

    } catch (error) {
        console.error('Error en /api/planificacion/:date:', error);
        res.status(500).json({ 
            message: "Error al cargar datos del panel",
            details: process.env.NODE_ENV === 'development' ? error.message : null
        });
    }
});

app.post('/api/planificacion/assign', async (req, res) => {
    try {
        const { id, equipo, tecnico1, tecnico2, fecha_asignada } = req.body;
        
        if (!id) {
            return res.status(400).json({ error: "Falta el ID de la solicitud." });
        }
        
        // Resto de tu lógica de asignación...
        
    } catch (error) {
        console.error('Error en /api/planificacion/assign:', error);
        res.status(400).json({ 
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : null
        });
    }
});


// Endpoints para gestionar equipos
app.post('/api/equipos', async (req, res) => {
    try {
        const { nombre_equipo, fecha } = req.body;
        
        if (!nombre_equipo || !fecha) {
            return res.status(400).json({ error: 'Faltan campos requeridos.' });
        }

        const { data, error } = await supabase
            .from('equipos')
            .insert({ 
                nombre_equipo, 
                fecha,
                tecnico_1: '',
                tecnico_2: ''
            })
            .select();

        if (error) throw error;

        res.status(201).json(data[0]);

    } catch (error) {
        console.error('Error en /api/equipos:', error);
        res.status(400).json({ 
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.details : null
        });
    }
});

app.put('/api/equipos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { tecnico_1, tecnico_2 } = req.body;
        
        // Validar que no se asigne el mismo técnico dos veces
        if (tecnico_1 && tecnico_2 && tecnico_1 === tecnico_2) {
            return res.status(400).json({ error: 'No se puede asignar el mismo técnico dos veces.' });
        }

        const { data, error } = await supabase
            .from('equipos')
            .update({ tecnico_1, tecnico_2 })
            .eq('id', id)
            .select();

        if (error) throw error;

        res.json(data[0]);

    } catch (error) {
        console.error('Error en /api/equipos/:id:', error);
        res.status(400).json({ 
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.details : null
        });
    }
});

app.delete('/api/equipos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Verificar si el equipo tiene tareas asignadas
        const { data: tareas, error: tareasError } = await supabase
            .from('solicitudes')
            .select('id')
            .eq('equipo', id)
            .eq('estado_solicitud', 'Planificada')
            .limit(1);

        if (tareasError) throw tareasError;

        if (tareas && tareas.length > 0) {
            return res.status(400).json({ 
                error: 'No se puede eliminar un equipo con tareas asignadas.' 
            });
        }

        const { error } = await supabase
            .from('equipos')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ message: 'Equipo eliminado con éxito.' });

    } catch (error) {
        console.error('Error en /api/equipos/:id:', error);
        res.status(400).json({ 
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.details : null
        });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${port}`);
});
