console.log(Buffer.from(String.fromCharCode(...new Uint16Array(Buffer.from('hello', 'utf16le')))).toString('base64'));
