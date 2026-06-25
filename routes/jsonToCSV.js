const express = require('express');
const multer = require('multer');
const { Parser } = require('json2csv');
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// Функция для поиска поля по имени (рекурсивно)
function findFieldByName(obj, fieldName) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj[fieldName] !== undefined) {
    return obj[fieldName];
  }

  for (let key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const result = findFieldByName(obj[key], fieldName);
      if (result !== null) return result;
    }
  }

  return null;
}

// Функция для извлечения атрибутов element
function extractElementAttributes(xmlString) {
  try {
    let cleanXml = xmlString;
    if (typeof cleanXml === 'string') {
      cleanXml = cleanXml.trim();
    }

    // Проверяем, что это элемент типа native[temp-valve]
    if (!cleanXml.includes('native[temp-valve]')) {
      return null;
    }

    // Находим тег element
    const elementMatch = cleanXml.match(/<element\s+([^>]*)>/);
    if (!elementMatch) {
      return null;
    }

    const attributesString = elementMatch[1];
    const result = {};

    // Разбираем атрибуты
    const attrRegex = /([\w-]+)\s*=\s*"([^"]*)"/g;
    let match;

    const allAttrs = {};
    while ((match = attrRegex.exec(attributesString)) !== null) {
      const key = match[1];
      const value = match[2];
      allAttrs[key] = value;
    }

    // Копируем все атрибуты, заменяя type
    for (let key in allAttrs) {
      if (key === 'type') {
        result[key] = 'saturn-devices[valve]';
      } else {
        result[key] = allAttrs[key];
      }
    }

    // Добавляем submodels как текстовое поле
    const submodelRegex = /<submodel[^>]*>/g;
    let submodelMatch;
    const submodels = [];

    while ((submodelMatch = submodelRegex.exec(cleanXml)) !== null) {
      submodels.push(submodelMatch[0]);
    }

    result['submodels'] = submodels.join(' ') || '';

    // Создаем обновленный XML с сохранением всех атрибутов
    let updatedXml = `<element`;

    if (result.id) {
      updatedXml += ` id="${result.id}"`;
    }
    if (result.name) {
      updatedXml += ` name="${result.name}"`;
    }

    updatedXml += ` type="${result.type}"`;

    const skipKeys = ['id', 'name', 'type', 'submodels', 'Model_Index', 'Original_Name', 'Original_Id', 'Original_Path', 'updated_params'];
    for (let key in result) {
      if (!skipKeys.includes(key) && result[key] !== undefined && result[key] !== '') {
        updatedXml += ` ${key}="${result[key]}"`;
      }
    }
    updatedXml += ` />`;

    result['updated_params'] = updatedXml;

    return result;
  } catch (error) {
    console.error('❌ Ошибка извлечения атрибутов:', error);
    return null;
  }
}

// Рекурсивный поиск всех элементов с native[temp-valve]
function findAllValves(obj, path = '') {
  const results = [];

  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      if (item && typeof item === 'object') {
        if (item.Params && typeof item.Params === 'string') {
          if (item.Params.includes('native[temp-valve]')) {
            results.push({
              model: item,
              index: index,
              path: path ? `${path}[${index}]` : `[${index}]`
            });
          }
        }
        const nestedResults = findAllValves(item, path ? `${path}[${index}]` : `[${index}]`);
        results.push(...nestedResults);
      }
    });
  } else {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (key === 'Params' && typeof obj[key] === 'string') {
          if (obj[key].includes('native[temp-valve]')) {
            results.push({
              model: obj,
              key: key,
              path: path ? `${path}.${key}` : key
            });
          }
        }
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          const nestedResults = findAllValves(obj[key], path ? `${path}.${key}` : key);
          results.push(...nestedResults);
        }
      }
    }
  }

  return results;
}

router.post('/', upload.single('file'), function(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Файл не загружен',
        message: 'Пожалуйста, выберите JSON файл для конвертации'
      });
    }

    console.log('📁 Получен файл:', req.file.originalname);
    console.log('📏 Размер файла:', req.file.size, 'байт');

    const fileContent = req.file.buffer.toString('utf-8');

    let jsonData;
    try {
      jsonData = JSON.parse(fileContent);
      console.log('✅ JSON успешно распарсен');
    } catch (parseError) {
      console.error('❌ Ошибка парсинга JSON:', parseError);
      return res.status(400).json({
        error: 'Неверный формат JSON',
        message: 'Загруженный файл не является корректным JSON'
      });
    }

    // Ищем все элементы с native[temp-valve]
    console.log('\n🔍 Поиск элементов с native[temp-valve]...');
    const valveResults = findAllValves(jsonData);

    console.log(`\n📊 Найдено элементов с native[temp-valve] (включая возможные дубликаты): ${valveResults.length}`);

    // ДЕДУПЛИКАЦИЯ: оставляем только уникальные id
    const uniqueMap = new Map();
    valveResults.forEach((result, index) => {
      const model = result.model;
      let params = result.key === 'Params' ? model[result.key] : model.Params;
      const parsed = extractElementAttributes(params);
      if (parsed && parsed.id) {
        if (!uniqueMap.has(parsed.id)) {
          uniqueMap.set(parsed.id, { result, parsed, model });
          console.log(`  ✅ Уникальный id: ${parsed.id}`);
        } else {
          console.log(`  ⚠️ Дубликат id=${parsed.id} пропущен (путь: ${result.path})`);
        }
      }
    });

    console.log(`\n📊 Уникальных элементов с native[temp-valve]: ${uniqueMap.size}`);

    if (uniqueMap.size === 0) {
      return res.status(400).json({
        error: 'Нет данных',
        message: 'Не найдено элементов с type="native[temp-valve]" для конвертации'
      });
    }

    // Извлекаем данные из уникальных элементов
    const extractedData = [];
    let index = 0;
    for (let [id, item] of uniqueMap) {
      index++;
      const { parsed, model, result } = item;
      parsed['Model_Index'] = model.CodeIdentity || index;
      parsed['Original_Name'] = model.Name || '';
      parsed['Original_Id'] = model.Id || '';
      parsed['Original_Path'] = result.path;
      extractedData.push(parsed);
      console.log(`  ✅ Добавлен элемент ${index}: id=${id}, name=${parsed.name}`);
    }

    console.log(`\n📊 Обработано: ${extractedData.length} уникальных элементов (native[temp-valve])`);

    // Показываем первый элемент для проверки
    console.log('\n📊 Пример первой записи:');
    console.log(JSON.stringify(extractedData[0], null, 2));

    // Конвертируем в CSV
    const parser = new Parser({
      quote: '"',
      escapedQuote: '""',
      delimiter: ',',
      eol: '\n'
    });

    const csv = parser.parse(extractedData);
    console.log('✅ CSV создан, размер:', csv.length, 'символов');

    // Отправляем CSV
    const outputFileName = req.file.originalname.replace(/\.json$/i, '_valves.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csv, 'utf-8'));
    res.send(csv);

  } catch (err) {
    console.error('❌ Ошибка конвертации:', err);
    res.status(500).json({
      error: 'Ошибка конвертации',
      message: err.message || 'Произошла ошибка при конвертации файла'
    });
  }
});

module.exports = router;